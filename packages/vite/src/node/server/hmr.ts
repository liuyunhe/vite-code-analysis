import fs from 'fs'
import path from 'path'
import { createServer, ViteDevServer } from '..'
import { createDebugger, normalizePath } from '../utils'
import { ModuleNode } from './moduleGraph'
import chalk from 'chalk'
import slash from 'slash'
import { Update } from 'types/hmrPayload'
import { CLIENT_DIR } from '../constants'
import { RollupError } from 'rollup'
import match from 'minimatch'

export const debugHmr = createDebugger('vite:hmr')

const normalizedClientDir = normalizePath(CLIENT_DIR)

export interface HmrOptions {
  protocol?: string
  host?: string
  port?: number
  path?: string
  timeout?: number
  overlay?: boolean
}

export interface HmrContext {
  file: string
  timestamp: number
  modules: Array<ModuleNode>
  read: () => string | Promise<string>
  server: ViteDevServer
}

function getShortName(file: string, root: string) {
  return file.startsWith(root + '/') ? path.posix.relative(root, file) : file
}

/**
 * 处理热模块替换（HMR）更新。
 * 该函数根据文件类型和当前服务器状态决定如何处理文件更改。
 * 例如，当配置文件或 .env 文件更改时，会自动重启服务器；对于客户端文件，会进行完全重载。
 *
 * @param file - 发生更改的文件路径。
 * @param server - Vite 开发服务器实例。
 * @returns 返回一个 Promise，解析为任意值。
 */
export async function handleHMRUpdate(
  file: string,
  server: ViteDevServer
): Promise<any> {
  const { ws, config, moduleGraph } = server
  const shortFile = getShortName(file, config.root)

  // 如果更改的是配置文件或 .env 文件，则重启服务器
  if (file === config.configFile || file.endsWith('.env')) {
    // TODO 自动重启服务器
    debugHmr(`[config change] ${chalk.dim(shortFile)}`)
    config.logger.info(
      chalk.green('config 或 .env 文件已更改，正在重启服务器...'),
      { clear: true, timestamp: true }
    )
    await restartServer(server)
    return
  }

  debugHmr(`[file change] ${chalk.dim(shortFile)}`)

  // 开发环境：客户端自身无法进行热更新，因此进行完全重载
  if (file.startsWith(normalizedClientDir)) {
    ws.send({
      type: 'full-reload',
      path: '*'
    })
    return
  }

  // 获取与文件相关的模块
  const mods = moduleGraph.getModulesByFile(file)

  // 检查是否有插件希望执行自定义的 HMR 处理
  const timestamp = Date.now()
  const hmrContext: HmrContext = {
    file,
    timestamp,
    modules: mods ? [...mods] : [],
    read: () => readModifiedFile(file),
    server
  }

  for (const plugin of config.plugins) {
    if (plugin.handleHotUpdate) {
      const filteredModules = await plugin.handleHotUpdate(hmrContext)
      if (filteredModules) {
        hmrContext.modules = filteredModules
      }
    }
  }

  // 如果没有匹配的模块
  if (!hmrContext.modules.length) {
    // 如果更改的是 HTML 文件，则进行页面重载
    if (file.endsWith('.html')) {
      config.logger.info(chalk.green(`page reload `) + chalk.dim(shortFile), {
        clear: true,
        timestamp: true
      })
      ws.send({
        type: 'full-reload',
        path: config.server.middlewareMode
          ? '*'
          : '/' + slash(path.relative(config.root, file))
      })
    } else {
      // loaded but not in the module graph, probably not js
      debugHmr(`[no modules matched] ${chalk.dim(shortFile)}`)
    }
    return
  }

  // 更新模块
  updateModules(shortFile, hmrContext.modules, timestamp, server)
}

/**
 * 更新模块函数
 * 该函数主要用于在开发服务器中更新受影响的模块，并根据更新情况决定是否进行页面重载或热更新
 *
 * @param file 触发更新的文件路径
 * @param modules 需要更新的模块节点数组
 * @param timestamp 更新的时间戳
 * @param config Vite开发服务器配置
 * @param ws WebSocket用于与客户端通信，发送更新或重载指令
 */
function updateModules(
  file: string,
  modules: ModuleNode[],
  timestamp: number,
  { config, ws }: ViteDevServer
) {
  // 存储本次更新的详细信息
  const updates: Update[] = []
  // 存储本次更新中被无效化的模块，避免重复处理
  const invalidatedModules = new Set<ModuleNode>()

  // 遍历所有需要更新的模块
  for (const mod of modules) {
    // 存储当前模块的边界信息，用于后续的热更新判断
    const boundaries = new Set<{
      boundary: ModuleNode
      acceptedVia: ModuleNode
    }>()
    // 无效化当前模块
    invalidate(mod, timestamp, invalidatedModules)
    // 判断当前模块的更新是否会导致死端（即无法通过热更新解决，需要页面重载）死端通常指传播过程中无法进一步进行或遇到问题的情况。
    const hasDeadEnd = propagateUpdate(mod, timestamp, boundaries)
    if (hasDeadEnd) {
      // 如果有死端，记录日志并发送页面重载指令
      config.logger.info(chalk.green(`page reload `) + chalk.dim(file), {
        clear: true,
        timestamp: true
      })
      ws.send({
        type: 'full-reload'
      })
      return
    }

    // 将边界信息转换为更新信息，添加到更新列表中
    updates.push(
      ...[...boundaries].map(({ boundary, acceptedVia }) => ({
        type: `${boundary.type}-update` as Update['type'],
        timestamp,
        path: boundary.url,
        acceptedPath: acceptedVia.url
      }))
    )
  }

  // 记录所有更新的日志
  config.logger.info(
    updates
      .map(({ path }) => chalk.green(`hmr update `) + chalk.dim(path))
      .join('\n'),
    { clear: true, timestamp: true }
  )

  // 发送更新指令，包括所有更新的详细信息
  ws.send({
    type: 'update',
    updates
  })
}

export async function handleFileAddUnlink(
  file: string,
  server: ViteDevServer,
  isUnlink = false
) {
  if (isUnlink && file in server._globImporters) {
    delete server._globImporters[file]
  } else {
    const modules = []
    for (const i in server._globImporters) {
      const { module, base, pattern } = server._globImporters[i]
      const relative = path.relative(base, file)
      if (match(relative, pattern)) {
        modules.push(module)
      }
    }
    if (modules.length > 0) {
      updateModules(
        getShortName(file, server.config.root),
        modules,
        Date.now(),
        server
      )
    }
  }
}

/**
 * 传播更新通知通过模块图。
 * 此函数用于在模块依赖图中传播更新通知，识别更新路径中是否存在任何死循环 。
 *
 * @param node - 更新的起始模块节点。
 * @param timestamp - 更新的时间戳，当前逻辑中未使用，但未来可能用于时间相关的处理。
 * @param boundaries - 存储边界模块及其接受更新的模块的集合。
 * @param currentChain - 当前的模块链，默认包含起始节点。
 * @returns 如果存在死循环 则返回 true，否则返回 false。
 */
function propagateUpdate(
  node: ModuleNode,
  timestamp: number,
  boundaries: Set<{
    boundary: ModuleNode
    acceptedVia: ModuleNode
  }>,
  currentChain: ModuleNode[] = [node]
): boolean {
  // 如果当前节点可以自我接受更新，则将其添加到边界集合中，并返回 false 表示没有死循环
  if (node.isSelfAccepting) {
    boundaries.add({
      boundary: node,
      acceptedVia: node
    })
    return false
  }

  // 如果当前节点没有导入者，则认为这是一个死循环 ，返回 true
  if (!node.importers.size) {
    return true
  }

  // 遍历当前节点的所有导入者
  for (const importer of node.importers) {
    const subChain = currentChain.concat(importer)
    // 如果导入者已经接受了当前节点的 HMR 依赖，则将其添加到边界集合中并继续下一个导入者
    if (importer.acceptedHmrDeps.has(node)) {
      boundaries.add({
        boundary: importer,
        acceptedVia: node
      })
      continue
    }

    // 如果导入者已经在当前链中，则认为存在循环依赖，这是一个死循环 ，返回 true
    if (currentChain.includes(importer)) {
      return true
    }

    // 递归调用 propagateUpdate 处理导入者节点，如果发现死循环 则返回 true
    if (propagateUpdate(importer, timestamp, boundaries, subChain)) {
      return true
    }
  }
  // 如果所有导入者都处理完毕且没有发现死循环 ，则返回 false
  return false
}

function invalidate(mod: ModuleNode, timestamp: number, seen: Set<ModuleNode>) {
  if (seen.has(mod)) {
    return
  }
  seen.add(mod)
  mod.lastHMRTimestamp = timestamp
  mod.transformResult = null
  mod.importers.forEach((importer) => invalidate(importer, timestamp, seen))
}

export function handlePrunedModules(
  mods: Set<ModuleNode>,
  { ws }: ViteDevServer
) {
  // update the disposed modules' hmr timestamp
  // since if it's re-imported, it should re-apply side effects
  // and without the timestamp the browser will not re-import it!
  const t = Date.now()
  mods.forEach((mod) => {
    mod.lastHMRTimestamp = t
    debugHmr(`[dispose] ${chalk.dim(mod.file)}`)
  })
  ws.send({
    type: 'prune',
    paths: [...mods].map((m) => m.url)
  })
}

const enum LexerState {
  inCall,
  inSingleQuoteString,
  inDoubleQuoteString,
  inTemplateString,
  inArray
}

/**
 * Lex import.meta.hot.accept() for accepted deps.
 * Since hot.accept() can only accept string literals or array of string
 * literals, we don't really need a heavy @babel/parse call on the entire source.
 *
 * @returns selfAccepts
 */
export function lexAcceptedHmrDeps(
  code: string,
  start: number,
  urls: Set<{ url: string; start: number; end: number }>
): boolean {
  let state: LexerState = LexerState.inCall
  // the state can only be 2 levels deep so no need for a stack
  let prevState: LexerState = LexerState.inCall
  let currentDep: string = ''

  function addDep(index: number) {
    urls.add({
      url: currentDep,
      start: index - currentDep.length - 1,
      end: index + 1
    })
    currentDep = ''
  }

  for (let i = start; i < code.length; i++) {
    const char = code.charAt(i)
    switch (state) {
      case LexerState.inCall:
      case LexerState.inArray:
        if (char === `'`) {
          prevState = state
          state = LexerState.inSingleQuoteString
        } else if (char === `"`) {
          prevState = state
          state = LexerState.inDoubleQuoteString
        } else if (char === '`') {
          prevState = state
          state = LexerState.inTemplateString
        } else if (/\s/.test(char)) {
          continue
        } else {
          if (state === LexerState.inCall) {
            if (char === `[`) {
              state = LexerState.inArray
            } else {
              // reaching here means the first arg is neither a string literal
              // nor an Array literal (direct callback) or there is no arg
              // in both case this indicates a self-accepting module
              return true // done
            }
          } else if (state === LexerState.inArray) {
            if (char === `]`) {
              return false // done
            } else if (char === ',') {
              continue
            } else {
              error(i)
            }
          }
        }
        break
      case LexerState.inSingleQuoteString:
        if (char === `'`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inDoubleQuoteString:
        if (char === `"`) {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else {
          currentDep += char
        }
        break
      case LexerState.inTemplateString:
        if (char === '`') {
          addDep(i)
          if (prevState === LexerState.inCall) {
            // accept('foo', ...)
            return false
          } else {
            state = prevState
          }
        } else if (char === '$' && code.charAt(i + 1) === '{') {
          error(i)
        } else {
          currentDep += char
        }
        break
      default:
        throw new Error('unknown import.meta.hot lexer state')
    }
  }
  return false
}

function error(pos: number) {
  const err = new Error(
    `import.meta.accept() can only accept string literals or an ` +
      `Array of string literals.`
  ) as RollupError
  err.pos = pos
  throw err
}

// vitejs/vite#610 when hot-reloading Vue files, we read immediately on file
// change event and sometimes this can be too early and get an empty buffer.
// Poll until the file's modified time has changed before reading again.
/**
 * 异步读取文件并返回其内容。如果文件为空，则会轮询检查文件是否在有限次数内被修改。
 *
 * @param file 要读取的文件路径。
 * @returns 返回一个Promise，解析为文件的内容。
 */
async function readModifiedFile(file: string): Promise<string> {
  const content = fs.readFileSync(file, 'utf-8')
  // 如果文件内容为空，则进行轮询检查文件是否被修改
  if (!content) {
    const mtime = fs.statSync(file).mtimeMs
    await new Promise((r) => {
      let n = 0
      // 定义轮询函数，检查文件的修改时间
      const poll = async () => {
        n++
        const newMtime = fs.statSync(file).mtimeMs
        // 如果文件修改时间发生变化或轮询次数超过10次，则停止轮询
        if (newMtime !== mtime || n > 10) {
          r(0)
        } else {
          setTimeout(poll, 10)
        }
      }
      setTimeout(poll, 10)
    })
    // 再次读取文件内容
    return fs.readFileSync(file, 'utf-8')
  } else {
    // 直接返回文件内容
    return content
  }
}

async function restartServer(server: ViteDevServer) {
  await server.close()
  ;(global as any).__vite_start_time = Date.now()
  const newServer = await createServer(server.config.inlineConfig)
  for (const key in newServer) {
    if (key !== 'app') {
      // @ts-ignore
      server[key] = newServer[key]
    }
  }
  if (!server.config.server.middlewareMode) {
    await server.listen()
  } else {
    server.config.logger.info('server restarted.', { timestamp: true })
  }
}
