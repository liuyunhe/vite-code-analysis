/**
 * This file is refactored into TypeScript based on
 * https://github.com/preactjs/wmr/blob/master/src/lib/rollup-plugin-container.js
 */

/**
https://github.com/preactjs/wmr/blob/master/LICENSE

MIT License

Copyright (c) 2020 The Preact Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import fs from 'fs'
import { resolve, join } from 'path'
import { Plugin } from '../plugin'
import {
  InputOptions,
  MinimalPluginContext,
  OutputOptions,
  ModuleInfo,
  NormalizedInputOptions,
  ChangeEvent,
  PartialResolvedId,
  ResolvedId,
  PluginContext as RollupPluginContext,
  LoadResult,
  SourceDescription,
  EmittedFile,
  SourceMap,
  RollupError
} from 'rollup'
import * as acorn from 'acorn'
import acornClassFields from 'acorn-class-fields'
import acornNumericSeparator from 'acorn-numeric-separator'
import acornStaticClassFeatures from 'acorn-static-class-features'
import merge from 'merge-source-map'
import MagicString from 'magic-string'
import { FSWatcher } from 'chokidar'
import {
  createDebugger,
  ensureWatchedFile,
  generateCodeFrame,
  isExternalUrl,
  normalizePath,
  numberToPos,
  prettifyUrl,
  timeFrom
} from '../utils'
import chalk from 'chalk'
import { ResolvedConfig } from '../config'
import { buildErrorMessage } from './middlewares/error'

export interface PluginContainerOptions {
  cwd?: string
  output?: OutputOptions
  modules?: Map<string, { info: ModuleInfo }>
  writeFile?: (name: string, source: string | Uint8Array) => void
}

export interface PluginContainer {
  options: InputOptions
  buildStart(options: InputOptions): Promise<void>
  watchChange(id: string, event?: ChangeEvent): void
  resolveId(
    id: string,
    importer?: string,
    skip?: Set<Plugin>,
    ssr?: boolean
  ): Promise<PartialResolvedId | null>
  transform(
    code: string,
    id: string,
    inMap?: SourceDescription['map'],
    ssr?: boolean
  ): Promise<SourceDescription | null>
  load(id: string, ssr?: boolean): Promise<LoadResult | null>
  close(): Promise<void>
}

type PluginContext = Omit<
  RollupPluginContext,
  // not documented
  | 'cache'
  // deprecated
  | 'emitAsset'
  | 'emitChunk'
  | 'getAssetFileName'
  | 'getChunkFileName'
  | 'isExternal'
  | 'moduleIds'
  | 'resolveId'
>

export let parser = acorn.Parser.extend(
  acornClassFields,
  acornStaticClassFeatures,
  acornNumericSeparator
)

export async function createPluginContainer(
  { plugins, logger, root, build: { rollupOptions } }: ResolvedConfig,
  watcher?: FSWatcher
): Promise<PluginContainer> {
  const isDebug = process.env.DEBUG

  const seenResolves: Record<string, true | undefined> = {}
  const debugResolve = createDebugger('vite:resolve')
  const debugPluginResolve = createDebugger('vite:plugin-resolve', {
    onlyWhenFocused: 'vite:plugin'
  })
  const debugPluginTransform = createDebugger('vite:plugin-transform', {
    onlyWhenFocused: 'vite:plugin'
  })

  // ---------------------------------------------------------------------------

  const MODULES = new Map()
  const watchFiles = new Set<string>()

  // get rollup version
  const rollupPkgPath = resolve(require.resolve('rollup'), '../../package.json')
  const minimalContext: MinimalPluginContext = {
    meta: {
      rollupVersion: JSON.parse(fs.readFileSync(rollupPkgPath, 'utf-8'))
        .version,
      watchMode: true
    }
  }

  function warnIncompatibleMethod(method: string, plugin: string) {
    logger.warn(
      chalk.cyan(`[plugin:${plugin}] `) +
        chalk.yellow(
          `context method ${chalk.bold(
            `${method}()`
          )} is not supported in serve mode. This plugin is likely not vite-compatible.`
        )
    )
  }

  // we should create a new context for each async hook pipeline so that the
  // active plugin in that pipeline can be tracked in a concurrency-safe manner.
  // using a class to make creating new contexts more efficient

  // 我们应该为每个异步钩子管道创建一个新的上下文，以便在该管道中跟踪
  // 当前活跃的插件，且能以并发安全的方式进行。
  // 使用类来提高创建新上下文的效率。
  /**
   * 插件上下文类，实现了 PluginContext 接口，提供了插件操作所需的各种功能和元数据。
   */
  class Context implements PluginContext {
    /**
     * 最小化上下文的元数据。
     */
    meta = minimalContext.meta

    /**
     * 是否为服务器端渲染模式。
     */
    ssr = false

    /**
     * 当前激活的插件。
     */
    _activePlugin: Plugin | null

    /**
     * 当前激活的模块ID。
     */
    _activeId: string | null = null

    /**
     * 当前激活的模块代码。
     */
    _activeCode: string | null = null

    /**
     * 需要跳过的插件集合。
     */
    _resolveSkips?: Set<Plugin>

    /**
     * 构造函数，初始化当前激活的插件。
     * @param initialPlugin - 初始激活的插件。
     */
    constructor(initialPlugin?: Plugin) {
      this._activePlugin = initialPlugin || null
    }

    /**
     * 解析代码。
     * @param code - 要解析的代码字符串。
     * @param opts - 解析选项。
     * @returns 解析后的结果。
     */
    parse(code: string, opts: any = {}) {
      return parser.parse(code, {
        sourceType: 'module',
        ecmaVersion: 2020,
        locations: true,
        ...opts
      })
    }

    /**
     * 解析模块ID。
     * @param id - 模块ID。
     * @param importer - 导入者模块ID。
     * @param options - 解析选项，包括是否跳过自身。
     * @returns 解析后的模块信息或null。
     */
    async resolve(
      id: string,
      importer?: string,
      options?: { skipSelf?: boolean }
    ) {
      let skips: Set<Plugin> | undefined
      if (options?.skipSelf && this._activePlugin) {
        skips = new Set(this._resolveSkips)
        skips.add(this._activePlugin)
      }
      let out = await container.resolveId(id, importer, skips, this.ssr)
      if (typeof out === 'string') out = { id: out }
      return out as ResolvedId | null
    }

    /**
     * 获取模块信息。
     * @param id - 模块ID。
     * @returns 模块信息。
     */
    getModuleInfo(id: string) {
      let mod = MODULES.get(id)
      if (mod) return mod.info
      mod = {
        /** @type {import('rollup').ModuleInfo} */
        // @ts-ignore-next
        info: {}
      }
      MODULES.set(id, mod)
      return mod.info
    }

    /**
     * 获取所有模块ID。
     * @returns 所有模块ID的迭代器。
     */
    getModuleIds() {
      return MODULES.keys()
    }

    /**
     * 添加监视文件。
     * @param id - 文件ID。
     */
    addWatchFile(id: string) {
      watchFiles.add(id)
      if (watcher) ensureWatchedFile(watcher, id, root)
    }

    /**
     * 获取所有被监视的文件。
     * @returns 被监视文件的数组。
     */
    getWatchFiles() {
      return [...watchFiles]
    }

    /**
     * 发布文件。
     * @param assetOrFile - 资源或文件。
     * @returns 空字符串。
     */
    emitFile(assetOrFile: EmittedFile) {
      warnIncompatibleMethod(`emitFile`, this._activePlugin!.name)
      return ''
    }

    /**
     * 设置资源源码。
     */
    setAssetSource() {
      warnIncompatibleMethod(`setAssetSource`, this._activePlugin!.name)
    }

    /**
     * 获取文件名。
     * @returns 空字符串。
     */
    getFileName() {
      warnIncompatibleMethod(`getFileName`, this._activePlugin!.name)
      return ''
    }

    /**
     * 发出警告。
     * @param e - 错误信息或对象。
     * @param position - 错误位置。
     */
    warn(
      e: string | RollupError,
      position?: number | { column: number; line: number }
    ) {
      const err = formatError(e, position, this)
      const msg = buildErrorMessage(
        err,
        [chalk.yellow(`warning: ${err.message}`)],
        false
      )
      logger.warn(msg, {
        clear: true,
        timestamp: true
      })
    }

    /**
     * 抛出错误。
     * @param e - 错误信息或对象。
     * @param position - 错误位置。
     * @throws 抛出格式化的错误。
     */
    error(
      e: string | RollupError,
      position?: number | { column: number; line: number }
    ): never {
      // 抛出的错误在这里被捕获，并传递给错误中间件。
      throw formatError(e, position, this)
    }
  }

  function formatError(
    e: string | RollupError,
    position: number | { column: number; line: number } | undefined,
    ctx: Context
  ) {
    const err = (typeof e === 'string' ? new Error(e) : e) as RollupError
    if (ctx._activePlugin) err.plugin = ctx._activePlugin.name
    if (ctx._activeId && !err.id) err.id = ctx._activeId
    if (ctx._activeCode) {
      err.pluginCode = ctx._activeCode
      const pos =
        position != null
          ? position
          : err.pos != null
          ? err.pos
          : // some rollup plugins, e.g. json, sets position instead of pos
            (err as any).position
      if (pos != null) {
        err.loc = err.loc || {
          file: err.id,
          ...numberToPos(ctx._activeCode, pos)
        }
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, pos)
      } else if (err.loc) {
        // css preprocessors may report errors in an included file
        if (!err.frame) {
          let code = ctx._activeCode
          if (err.loc.file) {
            err.id = normalizePath(err.loc.file)
            code = fs.readFileSync(err.loc.file, 'utf-8')
          }
          err.frame = generateCodeFrame(code, err.loc)
        }
      } else if ((err as any).line && (err as any).column) {
        err.loc = {
          file: err.id,
          line: (err as any).line,
          column: (err as any).column
        }
        err.frame = err.frame || generateCodeFrame(ctx._activeCode, err.loc)
      }
    }
    return err
  }

  class TransformContext extends Context {
    filename: string
    originalCode: string
    originalSourcemap: SourceMap | null = null
    sourcemapChain: NonNullable<SourceDescription['map']>[] = []
    combinedMap: SourceMap | null = null

    constructor(filename: string, code: string, inMap?: SourceMap | string) {
      super()
      this.filename = filename
      this.originalCode = code
      if (inMap) {
        this.sourcemapChain.push(inMap)
      }
    }

    _getCombinedSourcemap(createIfNull = false) {
      let combinedMap = this.combinedMap
      for (let m of this.sourcemapChain) {
        if (typeof m === 'string') m = JSON.parse(m)
        if (!('version' in (m as SourceMap))) {
          // empty, nullified source map
          combinedMap = this.combinedMap = null
          this.sourcemapChain.length = 0
          break
        }
        if (!combinedMap) {
          combinedMap = m as SourceMap
        } else {
          // merge-source-map will overwrite original sources if newMap also has
          // sourcesContent
          // @ts-ignore
          combinedMap = merge(combinedMap, {
            ...(m as SourceMap),
            sourcesContent: combinedMap.sourcesContent
          })
        }
      }
      if (!combinedMap) {
        return createIfNull
          ? new MagicString(this.originalCode).generateMap({
              includeContent: true,
              hires: true,
              source: this.filename
            })
          : null
      }
      if (combinedMap !== this.combinedMap) {
        this.combinedMap = combinedMap
        this.sourcemapChain.length = 0
      }
      return this.combinedMap
    }

    getCombinedSourcemap() {
      return this._getCombinedSourcemap(true) as SourceMap
    }
  }

  let closed = false

  // 定义一个插件容器，用于管理和执行各种构建插件
  const container: PluginContainer = {
    // 初始化容器选项，通过调用每个插件的options方法来扩展默认选项
    options: await (async () => {
      let options = rollupOptions
      for (const plugin of plugins) {
        if (!plugin.options) continue
        options =
          (await plugin.options.call(minimalContext, options)) || options
      }
      if (options.acornInjectPlugins) {
        parser = acorn.Parser.extend(
          ...[
            acornClassFields,
            acornStaticClassFeatures,
            acornNumericSeparator
          ].concat(options.acornInjectPlugins)
        )
      }
      return {
        acorn,
        acornInjectPlugins: [],
        ...options
      }
    })(),

    // 在构建开始时调用每个插件的buildStart方法
    async buildStart() {
      await Promise.all(
        plugins.map((plugin) => {
          if (plugin.buildStart) {
            return plugin.buildStart.call(
              new Context(plugin) as any,
              container.options as NormalizedInputOptions
            )
          }
        })
      )
    },

    // 解析模块ID，依次调用每个插件的resolveId方法，直到获得一个非空结果
    /**
     *
     * 此函数根据当前上下文和配置的插件将原始标识符（rawId）解析为更具体或绝对的形式。
     * 它是模块解析过程的核心部分，允许通过插件实现自定义解析逻辑。
     *
     * @param rawId 需要解析的原始标识符字符串。
     * @param importer 导入文件的路径，默认为项目根目录下的 index.html。用于解析相对路径。
     * @param skips 要跳过的插件集合，避免重复处理。
     * @param ssr 标记是否处于服务器端渲染模式。
     * @returns 如果解析成功，返回部分解析的标识符对象；否则返回 null。
     */
    async resolveId(rawId, importer = join(root, 'index.html'), skips, ssr) {
      // 初始化一个新的 Context 对象，用于保存解析过程中特定上下文的信息。
      const ctx = new Context()
      // 在上下文中设置 SSR 模式标志。
      ctx.ssr = !!ssr
      // 内部使用，用于跟踪解析过程中要跳过的插件。
      ctx._resolveSkips = skips
      // 调试模式记录解析开始时间。
      const resolveStart = isDebug ? Date.now() : 0

      // 初始化解析后的标识符为 null。
      let id: string | null = null
      // 初始化一个对象，用于存储部分解析结果。
      const partial: Partial<PartialResolvedId> = {}
      // 遍历所有插件，调用它们的 resolveId 方法（如果存在且不在跳过列表中）。
      for (const plugin of plugins) {
        if (!plugin.resolveId) continue
        if (skips?.has(plugin)) continue

        // 在上下文中设置当前活动的插件。
        ctx._activePlugin = plugin

        // 调试模式记录插件解析开始时间。
        const pluginResolveStart = isDebug ? Date.now() : 0
        // 调用插件的 resolveId 方法。
        const result = await plugin.resolveId.call(
          ctx as any,
          rawId,
          importer,
          {},
          ssr
        )
        if (!result) continue

        // 处理解析结果，结果可能是字符串或对象。
        if (typeof result === 'string') {
          id = result
        } else {
          id = result.id
          Object.assign(partial, result)
        }

        // 调试模式记录解析时间、插件名称和解析后的标识符。
        isDebug &&
          debugPluginResolve(
            timeFrom(pluginResolveStart),
            plugin.name,
            prettifyUrl(id, root)
          )

        // resolveId() 是 hookFirst - 返回第一个非空结果。
        break
      }

      // 如果标识符已解析且不是外部 URL，在调试模式下记录解析结果。
      if (isDebug && rawId !== id && !rawId.startsWith('/@fs/')) {
        const key = rawId + id
        // 避免重复记录
        if (!seenResolves[key]) {
          seenResolves[key] = true
          debugResolve(
            `${timeFrom(resolveStart)} ${chalk.cyan(rawId)} -> ${chalk.dim(id)}`
          )
        }
      }

      // 如果解析成功，返回部分解析的标识符对象；否则返回 null。
      if (id) {
        partial.id = isExternalUrl(id) ? id : normalizePath(id)
        return partial as PartialResolvedId
      } else {
        return null
      }
    },

    // 加载模块代码，调用每个插件的load方法，直到获得一个非空结果
    async load(id, ssr) {
      const ctx = new Context()
      ctx.ssr = !!ssr
      for (const plugin of plugins) {
        if (!plugin.load) continue
        ctx._activePlugin = plugin
        const result = await plugin.load.call(ctx as any, id, ssr)
        if (result != null) {
          return result
        }
      }
      return null
    },

    // 转换模块代码，调用每个插件的transform方法，对代码进行一系列转换
    async transform(code, id, inMap, ssr) {
      const ctx = new TransformContext(id, code, inMap as SourceMap)
      ctx.ssr = !!ssr
      for (const plugin of plugins) {
        if (!plugin.transform) continue
        ctx._activePlugin = plugin
        ctx._activeId = id
        ctx._activeCode = code
        const start = isDebug ? Date.now() : 0
        let result
        try {
          result = await plugin.transform.call(ctx as any, code, id, ssr)
        } catch (e) {
          ctx.error(e)
        }
        if (!result) continue
        isDebug &&
          debugPluginTransform(
            timeFrom(start),
            plugin.name,
            prettifyUrl(id, root)
          )
        if (typeof result === 'object') {
          code = result.code || ''
          if (result.map) ctx.sourcemapChain.push(result.map)
        } else {
          code = result
        }
      }
      return {
        code,
        map: ctx._getCombinedSourcemap()
      }
    },

    // 当监视的文件发生变化时调用插件的watchChange方法
    watchChange(id, event = 'update') {
      const ctx = new Context()
      if (watchFiles.has(id)) {
        for (const plugin of plugins) {
          if (!plugin.watchChange) continue
          ctx._activePlugin = plugin
          plugin.watchChange.call(ctx as any, id, { event })
        }
      }
    },

    // 关闭构建容器，调用每个插件的buildEnd和closeBundle方法进行清理
    async close() {
      if (closed) return
      const ctx = new Context()
      await Promise.all(
        plugins.map((p) => p.buildEnd && p.buildEnd.call(ctx as any))
      )
      await Promise.all(
        plugins.map((p) => p.closeBundle && p.closeBundle.call(ctx as any))
      )
      closed = true
    }
  }

  return container
}
