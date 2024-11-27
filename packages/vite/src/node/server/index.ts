import os from 'os'
import fs from 'fs'
import path from 'path'
import * as net from 'net'
import * as http from 'http'
import * as https from 'https'
import connect from 'connect'
import corsMiddleware from 'cors'
import chalk from 'chalk'
import { AddressInfo } from 'net'
import chokidar from 'chokidar'
import { resolveHttpServer } from './http'
import { resolveConfig, InlineConfig, ResolvedConfig } from '../config'
import {
  createPluginContainer,
  PluginContainer
} from '../server/pluginContainer'
import { FSWatcher, WatchOptions } from 'types/chokidar'
import { createWebSocketServer, WebSocketServer } from '../server/ws'
import { baseMiddleware } from './middlewares/base'
import { proxyMiddleware, ProxyOptions } from './middlewares/proxy'
import { transformMiddleware } from './middlewares/transform'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware
} from './middlewares/indexHtml'
import history from 'connect-history-api-fallback'
import {
  serveRawFsMiddleware,
  servePublicMiddleware,
  serveStaticMiddleware
} from './middlewares/static'
import { timeMiddleware } from './middlewares/time'
import { ModuleGraph, ModuleNode } from './moduleGraph'
import { Connect } from 'types/connect'
import { createDebugger, normalizePath } from '../utils'
import { errorMiddleware, prepareError } from './middlewares/error'
import { handleHMRUpdate, HmrOptions, handleFileAddUnlink } from './hmr'
import { openBrowser } from './openBrowser'
import launchEditorMiddleware from 'launch-editor-middleware'
import { TransformResult } from 'rollup'
import { TransformOptions, transformRequest } from './transformRequest'
import {
  transformWithEsbuild,
  ESBuildTransformResult
} from '../plugins/esbuild'
import { TransformOptions as EsbuildTransformOptions } from 'esbuild'
import { DepOptimizationMetadata, optimizeDeps } from '../optimizer'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { resolveSSRExternal } from '../ssr/ssrExternal'
import { ssrRewriteStacktrace } from '../ssr/ssrStacktrace'
import { createMissingImpoterRegisterFn } from '../optimizer/registerMissing'

export interface ServerOptions {
  host?: string
  port?: number
  /**
   * Enable TLS + HTTP/2.
   * Note: this downgrades to TLS only when the proxy option is also used.
   */
  https?: boolean | https.ServerOptions
  /**
   * Open browser window on startup
   */
  open?: boolean | string
  /**
   * Force dep pre-optimization regardless of whether deps have changed.
   */
  force?: boolean
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean
  /**
   * chokidar watch options
   * https://github.com/paulmillr/chokidar#api
   */
  watch?: WatchOptions
  /**
   * Configure custom proxy rules for the dev server. Expects an object
   * of `{ key: options }` pairs.
   * Uses [`http-proxy`](https://github.com/http-party/node-http-proxy).
   * Full options [here](https://github.com/http-party/node-http-proxy#options).
   *
   * Example `vite.config.js`:
   * ``` js
   * module.exports = {
   *   proxy: {
   *     // string shorthand
   *     '/foo': 'http://localhost:4567/foo',
   *     // with options
   *     '/api': {
   *       target: 'http://jsonplaceholder.typicode.com',
   *       changeOrigin: true,
   *       rewrite: path => path.replace(/^\/api/, '')
   *     }
   *   }
   * }
   * ```
   */
  proxy?: Record<string, string | ProxyOptions>
  /**
   * Configure CORS for the dev server.
   * Uses https://github.com/expressjs/cors.
   * Set to `true` to allow all methods from any origin, or configure separately
   * using an object.
   */
  cors?: CorsOptions | boolean
  /**
   * If enabled, vite will exit if specified port is already in use
   */
  strictPort?: boolean
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   */
  middlewareMode?: boolean
  /**
   * Prepend this folder to http requests, for use when proxying vite as a subfolder
   * Should start and end with the `/` character
   */
  base?: string
}

/**
 * https://github.com/expressjs/cors#configuration-options
 */
export interface CorsOptions {
  origin?:
    | CorsOrigin
    | ((origin: string, cb: (err: Error, origins: CorsOrigin) => void) => void)
  methods?: string | string[]
  allowedHeaders?: string | string[]
  exposedHeaders?: string | string[]
  credentials?: boolean
  maxAge?: number
  preflightContinue?: boolean
  optionsSuccessStatus?: number
}

export type CorsOrigin = boolean | string | RegExp | (string | RegExp)[]

export type ServerHook = (
  server: ViteDevServer
) => (() => void) | void | Promise<(() => void) | void>

export interface ViteDevServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * @deprecated use `server.middlewares` instead
   */
  app: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   */
  httpServer: http.Server | null
  /**
   * chokidar watcher instance
   * https://github.com/paulmillr/chokidar#api
   */
  watcher: FSWatcher
  /**
   * web socket server with `send(payload)` method
   */
  ws: WebSocketServer
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   */
  pluginContainer: PluginContainer
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   */
  moduleGraph: ModuleGraph
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   */
  transformRequest(
    url: string,
    options?: TransformOptions
  ): Promise<TransformResult | null>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(url: string, html: string): Promise<string>
  /**
   * Util for transforming a file with esbuild.
   * Can be useful for certain plugins.
   */
  transformWithEsbuild(
    code: string,
    filename: string,
    options?: EsbuildTransformOptions,
    inMap?: object
  ): Promise<ESBuildTransformResult>
  /**
   * Load a given URL as an instantiated module for SSR.
   */
  ssrLoadModule(
    url: string,
    options?: { isolated?: boolean }
  ): Promise<Record<string, any>>
  /**
   * Fix ssr error stacktrace
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Start the server.
   */
  listen(port?: number): Promise<ViteDevServer>
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * @internal
   */
  _optimizeDepsMetadata: DepOptimizationMetadata | null
  /**
   * Deps that are extenralized
   * @internal
   */
  _ssrExternals: string[] | null
  /**
   * @internal
   */
  _globImporters: Record<
    string,
    {
      base: string
      pattern: string
      module: ModuleNode
    }
  >
  /**
   * @internal
   */
  _isRunningOptimizer: boolean
  /**
   * @internal
   */
  _registerMissingImport: ((id: string, resolved: string) => void) | null
  /**
   * @internal
   */
  _pendingReload: Promise<void> | null
}

/**
 * 创建 Vite 开发服务器
 *
 * 此函数初始化并返回一个 Vite 开发服务器实例它负责处理配置、
 * 创建必要的中间件、设置文件监视器、加载插件、构建模块图、
 * 以及配置服务器的各种钩子和事件处理程序
 *
 * @param inlineConfig - 用户提供的配置对象，用于定制服务器行为
 * @returns 返回一个 Promise，解析为 ViteDevServer 实例
 */
export async function createServer(
  inlineConfig: InlineConfig = {}
): Promise<ViteDevServer> {
  // 解析配置，并设置为开发模式
  const config = await resolveConfig(inlineConfig, 'serve', 'development')
  // 获取项目根目录路径
  const root = config.root
  // 获取服务器配置，如果未提供则默认为空对象
  const serverConfig = config.server || {}
  // 判断是否为中间件模式
  const middlewareMode = !!serverConfig.middlewareMode

  // 创建 Connect 中间件实例
  const middlewares = connect() as Connect.Server
  // 根据配置解析 HTTP 服务器实例，中间件模式下不创建 HTTP 服务器
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares)
  // 创建 WebSocket 服务器，用于热更新和开发时的实时通信
  const ws = createWebSocketServer(httpServer, config)

  // 解析并应用文件监视器配置
  const { ignored = [], ...watchOptions } = serverConfig.watch || {}
  const watcher = chokidar.watch(path.resolve(root), {
    ignored: ['**/node_modules/**', '**/.git/**', ...ignored],
    ignoreInitial: true,
    ignorePermissionErrors: true,
    ...watchOptions
  }) as FSWatcher

  // 加载插件
  const plugins = config.plugins
  // 创建插件容器
  const container = await createPluginContainer(config, watcher)
  // 创建模块图实例，用于跟踪模块依赖关系
  const moduleGraph = new ModuleGraph(container)
  // 创建关闭 HTTP 服务器的函数
  const closeHttpServer = createSeverCloseFn(httpServer)

  // 初始化 ViteDevServer 对象
  const server: ViteDevServer = {
    config: config,
    middlewares,
    get app() {
      // 弃用警告，引导使用 middlewares
      config.logger.warn(
        `ViteDevServer.app is deprecated. Use ViteDevServer.middlewares instead.`
      )
      return middlewares
    },
    httpServer,
    watcher,
    pluginContainer: container,
    ws,
    moduleGraph,
    transformWithEsbuild,
    transformRequest(url, options) {
      // 请求转换中间件
      return transformRequest(url, server, options)
    },
    transformIndexHtml: null as any,
    ssrLoadModule(url, options) {
      // SSR 模块加载
      if (!server._ssrExternals) {
        server._ssrExternals = resolveSSRExternal(
          config,
          server._optimizeDepsMetadata
            ? Object.keys(server._optimizeDepsMetadata.optimized)
            : []
        )
      }
      return ssrLoadModule(url, server, !!options?.isolated)
    },
    ssrFixStacktrace(e) {
      // 修复 SSR 栈跟踪
      if (e.stack) {
        e.stack = ssrRewriteStacktrace(e.stack, moduleGraph)
      }
    },
    listen(port?: number) {
      // 启动服务器监听指定端口
      return startServer(server, port)
    },
    async close() {
      // 关闭服务器和所有相关资源
      await Promise.all([
        watcher.close(),
        ws.close(),
        container.close(),
        closeHttpServer()
      ])
    },
    _optimizeDepsMetadata: null,
    _ssrExternals: null,
    _globImporters: {} as Record<string, string[]>,
    _isRunningOptimizer: false,
    _registerMissingImport: null as MissingImportRegisterFn | null,
    _pendingReload: null as Promise<void> | null
  }

  // 设置 HTML 转换函数
  server.transformIndexHtml = createDevHtmlTransformFn(server)

  // 定义进程退出时的处理函数
  const exitProcess = async () => {
    try {
      await server.close()
    } finally {
      process.exit(0)
    }
  }

  // 监听进程退出信号
  process.once('SIGTERM', exitProcess)

  // 如果标准输入不是 TTY 模式，监听输入结束事件
  if (!process.stdin.isTTY) {
    process.stdin.on('end', exitProcess)
  }

  // 监听文件系统事件，处理文件变化
  watcher.on('change', async (file) => {
    file = normalizePath(file)
    // 文件变化时，使模块图缓存失效
    moduleGraph.onFileChange(file)
    if (serverConfig.hmr !== false) {
      try {
        // 尝试处理 HMR 更新
        await handleHMRUpdate(file, server)
      } catch (err) {
        // 发送错误信息到客户端
        ws.send({
          type: 'error',
          err: prepareError(err)
        })
      }
    }
  })

  // 监听新文件添加事件
  watcher.on('add', (file) => {
    handleFileAddUnlink(normalizePath(file), server)
  })

  // 监听文件删除事件
  watcher.on('unlink', (file) => {
    handleFileAddUnlink(normalizePath(file), server, true)
  })

  // 应用插件的服务器配置钩子
  const postHooks: ((() => void) | void)[] = []
  for (const plugin of plugins) {
    if (plugin.configureServer) {
      postHooks.push(await plugin.configureServer(server))
    }
  }

  // 内部中间件配置 ------------------------------------------------------

  // 请求计时中间件
  if (process.env.DEBUG) {
    middlewares.use(timeMiddleware(root))
  }

  // CORS 配置中间件
  const { cors } = serverConfig
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // 代理配置中间件
  const { proxy } = serverConfig
  if (proxy) {
    middlewares.use(proxyMiddleware(server))
  }

  // 基础路径配置中间件
  if (config.base !== '/') {
    middlewares.use(baseMiddleware(server))
  }

  // 编辑器支持中间件
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  // HMR 重连心跳中间件
  middlewares.use('/__vite_ping', (_, res) => res.end('pong'))

  // 静态文件服务中间件
  middlewares.use(servePublicMiddleware(config.publicDir))

  // 主转换中间件
  middlewares.use(transformMiddleware(server))

  // 静态文件服务中间件
  middlewares.use(serveRawFsMiddleware())
  middlewares.use(serveStaticMiddleware(root, config))

  // SPA 回退中间件
  if (!middlewareMode) {
    middlewares.use(
      history({
        logger: createDebugger('vite:spa-fallback'),
        rewrites: [
          {
            from: /\/$/,
            to({ parsedUrl }: any) {
              const rewritten = parsedUrl.pathname + 'index.html'
              if (fs.existsSync(path.join(root, rewritten))) {
                return rewritten
              } else {
                return `/index.html`
              }
            }
          }
        ]
      })
    )
  }

  // 运行后配置钩子
  postHooks.forEach((fn) => fn && fn())

  if (!middlewareMode) {
    // 转换 index.html
    middlewares.use(indexHtmlMiddleware(server))
    // 处理 404 错误
    middlewares.use((_, res) => {
      res.statusCode = 404
      res.end()
    })
  }

  // 错误处理中间件
  middlewares.use(errorMiddleware(server, middlewareMode))

  // 运行优化器
  const runOptimize = async () => {
    if (config.optimizeCacheDir) {
      server._isRunningOptimizer = true
      try {
        server._optimizeDepsMetadata = await optimizeDeps(config)
      } finally {
        server._isRunningOptimizer = false
      }
      server._registerMissingImport = createMissingImpoterRegisterFn(server)
    }
  }

  if (!middlewareMode && httpServer) {
    // 在服务器启动前运行优化器
    const listen = httpServer.listen.bind(httpServer)
    httpServer.listen = (async (port: number, ...args: any[]) => {
      try {
        await container.buildStart({})
        await runOptimize()
      } catch (e) {
        httpServer.emit('error', e)
        return
      }
      return listen(port, ...args)
    }) as any

    httpServer.once('listening', () => {
      // 更新实际端口值
      serverConfig.port = (httpServer.address() as AddressInfo).port
    })
  } else {
    await runOptimize()
  }

  // 返回 ViteDevServer 实例
  return server
}

/**
 * 异步启动服务器。
 *
 * @param server Vite 开发服务器实例。
 * @param inlinePort 要使用的端口号，可选。
 * @returns 返回一个 Promise，解析为 Vite 开发服务器实例。
 *
 * 此函数尝试在指定的端口或服务器配置中的默认端口上启动服务器。
 * 如果端口已被占用，除非配置了 strictPort，否则将尝试使用下一个可用端口。
 * 它还处理记录服务器启动信息，并在配置允许的情况下自动打开浏览器。
 */
async function startServer(
  server: ViteDevServer,
  inlinePort?: number
): Promise<ViteDevServer> {
  // 检查 httpServer 是否存在，如果不存在，则抛出错误，因为无法在中间件模式下调用 server.listen。
  const httpServer = server.httpServer
  if (!httpServer) {
    throw new Error('无法在中间件模式下调用 server.listen。')
  }

  // 初始化服务器选项、端口、主机名、协议、日志记录器和基础 URL。
  const options = server.config.server || {}
  let port = inlinePort || options.port || 3000
  let hostname = options.host || 'localhost'
  const protocol = options.https ? 'https' : 'http'
  const info = server.config.logger.info
  const base = server.config.base

  // 返回一个 Promise，尝试启动服务器。
  return new Promise((resolve, reject) => {
    // 定义错误处理函数。
    const onError = (e: Error & { code?: string }) => {
      if (e.code === 'EADDRINUSE') {
        if (options.strictPort) {
          httpServer.removeListener('error', onError)
          reject(new Error(`端口 ${port} 已被占用`))
        } else {
          info(`端口 ${port} 已被占用，尝试使用另一个端口...`)
          httpServer.listen(++port)
        }
      } else {
        httpServer.removeListener('error', onError)
        reject(e)
      }
    }

    // 监听错误事件。
    httpServer.on('error', onError)

    // 监听端口。
    httpServer.listen(port, () => {
      httpServer.removeListener('error', onError)

      // 记录服务器启动信息。
      info(`\n ⚡ Vite 开发服务器正在运行于:\n`, {
        clear: !server.config.logger.hasWarned
      })
      const interfaces = os.networkInterfaces()
      Object.keys(interfaces).forEach((key) =>
        (interfaces[key] || [])
          .filter((details) => details.family === 'IPv4')
          .map((detail) => {
            return {
              type: detail.address.includes('127.0.0.1')
                ? '本地:   '
                : '网络: ',
              host: detail.address.replace('127.0.0.1', hostname)
            }
          })
          .forEach(({ type, host }) => {
            const url = `${protocol}://${host}:${chalk.bold(port)}${base}`
            info(`  > ${type} ${chalk.cyan(url)}`)
          })
      )

      // 记录启动时间。
      if (global.__vite_start_time) {
        info(
          chalk.cyan(
            `\n  启动完成，耗时 ${Date.now() - global.__vite_start_time}ms.\n`
          )
        )
      }

      // 记录 CPU 性能分析结果。
      const profileSession = global.__vite_profile_session
      if (profileSession) {
        profileSession.post('Profiler.stop', (err: any, { profile }: any) => {
          // Write profile to disk, upload, etc.
          if (!err) {
            const outPath = path.resolve('./vite-profile.cpuprofile')
            fs.writeFileSync(outPath, JSON.stringify(profile))
            info(
              chalk.yellow(
                `  CPU 性能分析结果已保存至 ${chalk.white.dim(outPath)}\n`
              )
            )
          } else {
            throw err
          }
        })
      }

      // 自动打开浏览器。
      if (options.open) {
        const path = typeof options.open === 'string' ? options.open : base
        openBrowser(
          `${protocol}://${hostname}:${port}${path}`,
          true,
          server.config.logger
        )
      }

      // 解析 Promise。
      resolve(server)
    })
  })
}

/**
 * 创建一个用于关闭服务器的函数
 * 此函数主要处理服务器的优雅关闭过程，确保所有已打开的连接都被正确关闭后，才关闭服务器
 * 
 * @param server 可能为null的http.Server实例，用于处理连接和关闭操作
 * @returns 返回一个函数，该函数当被调用时，会关闭服务器并结束所有打开的连接
 */
function createSeverCloseFn(server: http.Server | null) {
  // 如果server为null，则返回一个空的函数，因为没有服务器实例需要关闭
  if (!server) {
    return () => {}
  }

  // 标记是否服务器已经开始监听连接
  let hasListened = false
  // 存储所有当前打开的socket连接
  const openSockets = new Set<net.Socket>()

  // 当有新的连接时，将该连接添加到openSockets集合中，并监听连接的关闭事件
  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  // 当服务器开始监听时，设置hasListened标记为true
  server.once('listening', () => {
    hasListened = true
  })

  // 返回一个函数，用于关闭服务器和所有打开的连接
  return () =>
    new Promise<void>((resolve, reject) => {
      // 销毁所有打开的socket连接
      openSockets.forEach((s) => s.destroy())
      // 如果服务器已经开始监听，则也需要关闭服务器
      if (hasListened) {
        server.close((err) => {
          // 根据服务器关闭结果，决定是解析Promise还是拒绝Promise
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        // 如果服务器从未开始监听，直接解析Promise
        resolve()
      }
    })
}
