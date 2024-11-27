import fs from 'fs'
import path from 'path'
import { Plugin } from './plugin'
import Rollup from 'rollup'
import { BuildOptions, resolveBuildOptions } from './build'
import { ServerOptions } from './server'
import { CSSOptions } from './plugins/css'
import {
  createDebugger,
  isExternalUrl,
  isObject,
  lookupFile,
  normalizePath
} from './utils'
import { resolvePlugins } from './plugins'
import chalk from 'chalk'
import { ESBuildOptions, esbuildPlugin, stopService } from './plugins/esbuild'
import dotenv from 'dotenv'
import dotenvExpand from 'dotenv-expand'
import { Alias, AliasOptions } from 'types/alias'
import { CLIENT_DIR, DEFAULT_ASSETS_RE, DEP_CACHE_DIR } from './constants'
import { ResolveOptions, resolvePlugin } from './plugins/resolve'
import { createLogger, Logger, LogLevel } from './logger'
import { DepOptimizationOptions } from './optimizer'
import { createFilter } from '@rollup/pluginutils'
import { ResolvedBuildOptions } from '.'
import { parse as parseUrl } from 'url'
import { JsonOptions } from './plugins/json'
import {
  createPluginContainer,
  PluginContainer
} from './server/pluginContainer'
import aliasPlugin from '@rollup/plugin-alias'

const debug = createDebugger('vite:config')

export interface ConfigEnv {
  command: 'build' | 'serve'
  mode: string
}

export type UserConfigFn = (env: ConfigEnv) => UserConfig
export type UserConfigExport = UserConfig | UserConfigFn

/**
 * Type helper to make it easier to use vite.config.ts
 * accepts a direct {@link UserConfig} object, or a function that returns it.
 * The function receives a {@link ConfigEnv} object that exposes two properties:
 * `command` (either `'build'` or `'serve'`), and `mode`.
 */
export function defineConfig(config: UserConfigExport): UserConfigExport {
  return config
}

export interface UserConfig {
  /**
   * Project root directory. Can be an absolute path, or a path relative from
   * the location of the config file itself.
   * @default process.cwd()
   */
  root?: string
  /**
   * Base public path when served in development or production.
   * @default '/'
   */
  base?: string
  /**
   * Directory to serve as plain static assets. Files in this directory are
   * served and copied to build dist dir as-is without transform. The value
   * can be either an absolute file system path or a path relative to <root>.
   * @default 'public'
   */
  publicDir?: string
  /**
   * Explicitly set a mode to run in. This will override the default mode for
   * each command, and can be overridden by the command line --mode option.
   */
  mode?: string
  /**
   * Import aliases
   */
  alias?: AliasOptions
  /**
   * Define global variable replacements.
   * Entries will be defined on `window` during dev and replaced during build.
   */
  define?: Record<string, any>
  /**
   * Array of vite plugins to use.
   */
  plugins?: (Plugin | Plugin[])[]
  /**
   * CSS related options (preprocessors and CSS modules)
   */
  css?: CSSOptions
  /**
   * JSON loading options
   */
  json?: JsonOptions
  /**
   * Transform options to pass to esbuild.
   * Or set to `false` to disable esbuild.
   */
  esbuild?: ESBuildOptions | false
  /**
   * Specify additional files to be treated as static assets.
   */
  assetsInclude?: string | RegExp | (string | RegExp)[]
  /**
   * Server specific options, e.g. host, port, https...
   */
  server?: ServerOptions
  /**
   * Build specific options
   */
  build?: BuildOptions
  /**
   * Dep optimization options
   */
  optimizeDeps?: DepOptimizationOptions
  /**
   * SSR specific options
   * @alpha
   */
  ssr?: SSROptions
  /**
   * Force Vite to always resolve listed dependencies to the same copy (from
   * project root).
   */
  dedupe?: string[]
  /**
   * Log level.
   * Default: 'info'
   */
  logLevel?: LogLevel
  /**
   * Default: true
   */
  clearScreen?: boolean
}

export interface SSROptions {
  external?: string[]
  noExternal?: string[]
}

export interface InlineConfig extends UserConfig {
  configFile?: string | false
}

export type ResolvedConfig = Readonly<
  Omit<UserConfig, 'plugins' | 'alias' | 'assetsInclude'> & {
    configFile: string | undefined
    inlineConfig: UserConfig
    root: string
    base: string
    publicDir: string
    command: 'build' | 'serve'
    mode: string
    isProduction: boolean
    optimizeCacheDir: string | undefined
    env: Record<string, any>
    alias: Alias[]
    plugins: readonly Plugin[]
    server: ServerOptions
    build: ResolvedBuildOptions
    assetsInclude: (file: string) => boolean
    logger: Logger
    createResolver: (options?: Partial<ResolveOptions>) => ResolveFn
  }
>

export { ResolveOptions }

export type ResolveFn = (
  id: string,
  importer?: string,
  aliasOnly?: boolean
) => Promise<string | undefined>

/**
 * 解析配置函数
 * @param inlineConfig - 用户提供的内联配置
 * @param command - 命令类型，可以是 'build' 或 'serve'
 * @param defaultMode - 默认模式，默认为 'development'
 * @returns 解析后的配置对象
 */
export async function resolveConfig(
  inlineConfig: InlineConfig,
  command: 'build' | 'serve',
  defaultMode = 'development'
): Promise<ResolvedConfig> {
  let config = inlineConfig
  let mode = inlineConfig.mode || defaultMode
  const logger = createLogger(config.logLevel, config.clearScreen)

  // 如果模式为生产环境，设置 NODE_ENV 为 'production'
  if (mode === 'production') {
    process.env.NODE_ENV = 'production'
  }

  // 加载配置文件
  let { configFile } = config
  if (configFile !== false) {
    const loadResult = await loadConfigFromFile(
      { mode, command },
      configFile,
      config.root,
      config.logLevel
    )
    if (loadResult) {
      config = mergeConfig(loadResult.config, config)
      configFile = loadResult.path
    }
  }
  // 用户配置可能提供了替代模式
  mode = config.mode || mode

  // 解析插件
  const rawUserPlugins = (config.plugins || []).flat().filter((p) => {
    return !p.apply || p.apply === command
  })
  // 根据插件的执行顺序将用户提供的原始插件列表进行排序
  // 插件列表被分为三类：预处理插件、普通插件和后处理插件
  // 这样做是为了确保插件按照正确的顺序执行，从而避免潜在的执行顺序问题
  const [prePlugins, normalPlugins, postPlugins] = sortUserPlugins(
    rawUserPlugins
  )

  // 运行配置钩子
  const userPlugins = [...prePlugins, ...normalPlugins, ...postPlugins]
  userPlugins.forEach((p) => {
    if (p.config) {
      const res = p.config(config)
      if (res) {
        config = mergeConfig(config, res)
      }
    }
  })

  // 解析根目录
  const resolvedRoot = normalizePath(
    config.root ? path.resolve(config.root) : process.cwd()
  )

  // 解析别名并添加内部客户端别名
  const resolvedAlias = mergeAlias(
    [{ find: /^\/@vite\//, replacement: () => CLIENT_DIR + '/' }],
    config.alias || []
  )

  // 加载环境变量文件
  const userEnv = loadEnv(mode, resolvedRoot)

  // 判断是否为生产环境
  const isProduction = (process.env.VITE_USER_NODE_ENV || mode) === 'production'
  if (isProduction) {
    process.env.NODE_ENV = 'production'
  }

  // 解析公共基础 URL
  if (config.build?.base) {
    logger.warn(
      chalk.yellow.bold(
        `(!) "build.base" 配置选项已弃用。` +
          `"base" 现在是一个根级别的配置选项。`
      )
    )
    config.base = config.build.base
  }

  const BASE_URL = resolveBaseUrl(config.base, command === 'build', logger)
  const resolvedBuildOptions = resolveBuildOptions(config.build)

  // 解析优化缓存目录
  const pkgPath = lookupFile(resolvedRoot, [`package.json`], true)
  const optimizeCacheDir =
    pkgPath && path.join(path.dirname(pkgPath), `node_modules/${DEP_CACHE_DIR}`)

  // 创建资产过滤器
  const assetsFilter = config.assetsInclude
    ? createFilter(config.assetsInclude)
    : () => false

  // 创建内部解析器
  const createResolver: ResolvedConfig['createResolver'] = (options) => {
    let aliasContainer: PluginContainer | undefined
    let resolverContainer: PluginContainer | undefined
    return async (id, importer, aliasOnly) => {
      let container: PluginContainer
      if (aliasOnly) {
        container =
          aliasContainer ||
          (aliasContainer = await createPluginContainer({
            ...resolved,
            plugins: [aliasPlugin({ entries: resolved.alias })]
          }))
      } else {
        container =
          resolverContainer ||
          (resolverContainer = await createPluginContainer({
            ...resolved,
            plugins: [
              aliasPlugin({ entries: resolved.alias }),
              resolvePlugin({
                root: resolvedRoot,
                dedupe: resolved.dedupe,
                isProduction,
                isBuild: command === 'build',
                asSrc: true,
                relativeFirst: false,
                tryIndex: true,
                ...options
              })
            ]
          }))
      }
      return (await container.resolveId(id, importer))?.id
    }
  }

  // 构建最终解析的配置对象
  const resolved: ResolvedConfig = {
    ...config,
    configFile: configFile ? normalizePath(configFile) : undefined,
    inlineConfig,
    root: resolvedRoot,
    base: BASE_URL,
    publicDir: path.resolve(resolvedRoot, config.publicDir || 'public'),
    command,
    mode,
    isProduction,
    optimizeCacheDir,
    alias: resolvedAlias,
    plugins: userPlugins,
    server: config.server || {},
    build: resolvedBuildOptions,
    env: {
      ...userEnv,
      BASE_URL,
      MODE: mode,
      DEV: !isProduction,
      PROD: isProduction
    },
    assetsInclude(file: string) {
      return DEFAULT_ASSETS_RE.test(file) || assetsFilter(file)
    },
    logger,
    createResolver
  }

  // 解析插件
  ;(resolved as any).plugins = await resolvePlugins(
    resolved,
    prePlugins,
    normalPlugins,
    postPlugins
  )

  // 调用配置解析完成钩子
  userPlugins.forEach((p) => {
    if (p.configResolved) {
      p.configResolved(resolved)
    }
  })

  // 打印调试信息
  if (process.env.DEBUG) {
    debug(`使用解析后的配置: %O`, {
      ...resolved,
      plugins: resolved.plugins.map((p) => p.name)
    })
  }
  return resolved
}

/**
 * Resolve base. Note that some users use Vite to build for non-web targets like
 * electron or expects to deploy
 */
function resolveBaseUrl(
  base: UserConfig['base'] = '/',
  isBuild: boolean,
  logger: Logger
): string {
  // #1669 special treatment for empty for same dir relative base
  if (base === '' || base === './') {
    return isBuild ? base : '/'
  }
  if (base.startsWith('.')) {
    logger.warn(
      chalk.yellow.bold(
        `(!) invalid "base" option: ${base}. The value can only be an absolute ` +
          `URL, ./, or an empty string.`
      )
    )
    base = '/'
  }

  // external URL
  if (isExternalUrl(base)) {
    if (!isBuild) {
      // get base from full url during dev
      const parsed = parseUrl(base)
      base = parsed.pathname || '/'
    }
  } else {
    // ensure leading slash
    if (!base.startsWith('/')) {
      logger.warn(
        chalk.yellow.bold(`(!) "base" option should start with a slash.`)
      )
      base = '/' + base
    }
  }

  // ensure ending slash
  if (!base.endsWith('/')) {
    logger.warn(chalk.yellow.bold(`(!) "base" option should end with a slash.`))
    base += '/'
  }

  return base
}

export function mergeConfig(
  a: Record<string, any>,
  b: Record<string, any>,
  isRoot = true
): Record<string, any> {
  const merged: Record<string, any> = { ...a }
  for (const key in b) {
    const value = b[key]
    if (value == null) {
      continue
    }

    const existing = merged[key]
    if (Array.isArray(existing) && Array.isArray(value)) {
      merged[key] = [...existing, ...value]
      continue
    }
    if (isObject(existing) && isObject(value)) {
      merged[key] = mergeConfig(existing, value, false)
      continue
    }

    // root fields that require special handling
    if (existing != null && isRoot) {
      if (key === 'alias') {
        merged[key] = mergeAlias(existing, value)
        continue
      } else if (key === 'assetsInclude') {
        merged[key] = [].concat(existing, value)
        continue
      }
    }

    merged[key] = value
  }
  return merged
}

function mergeAlias(a: AliasOptions = [], b: AliasOptions = []): Alias[] {
  return [...normalizeAlias(a), ...normalizeAlias(b)]
}

function normalizeAlias(o: AliasOptions): Alias[] {
  return Array.isArray(o)
    ? o.map(normalizeSingleAlias)
    : Object.keys(o).map((find) =>
        normalizeSingleAlias({
          find,
          replacement: (o as any)[find]
        })
      )
}

// https://github.com/vitejs/vite/issues/1363
// work around https://github.com/rollup/plugins/issues/759
function normalizeSingleAlias({ find, replacement }: Alias): Alias {
  if (
    typeof find === 'string' &&
    find.endsWith('/') &&
    replacement.endsWith('/')
  ) {
    find = find.slice(0, find.length - 1)
    replacement = replacement.slice(0, replacement.length - 1)
  }
  return { find, replacement }
}

export function sortUserPlugins(
  plugins: (Plugin | Plugin[])[] | undefined
): [Plugin[], Plugin[], Plugin[]] {
  const prePlugins: Plugin[] = []
  const postPlugins: Plugin[] = []
  const normalPlugins: Plugin[] = []

  if (plugins) {
    plugins.flat().forEach((p) => {
      if (p.enforce === 'pre') prePlugins.push(p)
      else if (p.enforce === 'post') postPlugins.push(p)
      else normalPlugins.push(p)
    })
  }

  return [prePlugins, normalPlugins, postPlugins]
}

/**
 * 异步加载配置文件。
 *
 * 该函数尝试从指定或默认的配置文件中加载 Vite 配置。
 * 它支持加载用 JavaScript（包括 ES 模块）、TypeScript 和 JSON 编写的配置文件。
 * 如果提供了显式的配置路径，则尝试从该路径解析并加载配置。
 * 如果未提供路径，则按以下顺序查找配置文件：
 * 1. vite.config.js
 * 2. vite.config.mjs（用于 ES 模块）
 * 3. vite.config.ts（用于 TypeScript）
 * 如果找到配置文件，则根据其类型进行加载和解析。
 *
 * @param configEnv 配置环境变量。
 * @param configFile 可选的显式配置文件路径。
 * @param configRoot 配置文件的根目录，默认为当前工作目录。
 * @param logLevel 日志级别。
 * @returns 返回一个包含配置文件路径和配置对象的对象，如果未找到配置文件则返回 null。
 */
export async function loadConfigFromFile(
  configEnv: ConfigEnv,
  configFile?: string,
  configRoot: string = process.cwd(),
  logLevel?: LogLevel
): Promise<{ path: string; config: UserConfig } | null> {
  const start = Date.now()

  let resolvedPath: string | undefined
  let isTS = false
  let isMjs = false

  // 检查 package.json 中是否有 type: "module" 并设置 `isMjs` 为 true
  try {
    const pkg = lookupFile(configRoot, ['package.json'])
    if (pkg && JSON.parse(pkg).type === 'module') {
      isMjs = true
    }
  } catch (e) {}

  if (configFile) {
    // 显式配置路径始终从当前工作目录解析
    resolvedPath = path.resolve(configFile)
  } else {
    // 隐式配置文件从内联根目录（如果存在）加载，否则从当前工作目录加载
    const jsconfigFile = path.resolve(configRoot, 'vite.config.js')
    if (fs.existsSync(jsconfigFile)) {
      resolvedPath = jsconfigFile
    }

    if (!resolvedPath) {
      const mjsconfigFile = path.resolve(configRoot, 'vite.config.mjs')
      if (fs.existsSync(mjsconfigFile)) {
        resolvedPath = mjsconfigFile
        isMjs = true
      }
    }

    if (!resolvedPath) {
      const tsconfigFile = path.resolve(configRoot, 'vite.config.ts')
      if (fs.existsSync(tsconfigFile)) {
        resolvedPath = tsconfigFile
        isTS = true
      }
    }
  }

  if (!resolvedPath) {
    debug('未找到配置文件。')
    return null
  }

  try {
    let userConfig: UserConfigExport | undefined

    if (isMjs) {
      const fileUrl = require('url').pathToFileURL(resolvedPath)
      if (isTS) {
        // 在不需要用户运行带有 --experimental-loader 的 Node 之前，我们需要在这里进行一个变通：
        // 先将配置文件与 TypeScript 转换一起打包，写入磁盘，使用原生 Node ESM 加载，然后删除文件。
        const code = await bundleConfigFile(resolvedPath, true)
        fs.writeFileSync(resolvedPath + '.js', code)
        userConfig = (await eval(`import(fileUrl + '.js?t=${Date.now()}')`))
          .default
        fs.unlinkSync(resolvedPath + '.js')
        debug(
          `TS + 原生 ESM 配置在 ${Date.now() - start}ms 内加载完成`,
          fileUrl
        )
      } else {
        // 使用 eval 以避免被 TS/Rollup 编译掉
        // 追加查询参数以强制重新加载新鲜配置（服务器重启时）
        userConfig = (await eval(`import(fileUrl + '?t=${Date.now()}')`))
          .default
        debug(`原生 ESM 配置在 ${Date.now() - start}ms 内加载完成`, fileUrl)
      }
    }

    if (!userConfig && !isTS && !isMjs) {
      // 1. 尝试直接 require 模块（假设为 CommonJS）
      try {
        // 清除缓存以防止服务器重启时的问题
        delete require.cache[require.resolve(resolvedPath)]
        userConfig = require(resolvedPath)
        debug(`CJS 配置在 ${Date.now() - start}ms 内加载完成`)
      } catch (e) {
        const ignored = new RegExp(
          [
            `Cannot use import statement`,
            `Unexpected token 'export'`,
            `Must use import to load ES Module`,
            `Unexpected identifier` // #1635 Node <= 12.4 没有 ESM 检测
          ].join('|')
        )
        if (!ignored.test(e.message)) {
          throw e
        }
      }
    }

    if (!userConfig) {
      // 2. 如果到达这里，文件是 TypeScript 或使用 ES 导入语法，或者用户在 package.json 中有 type: "module" (#917)
      // 使用 Rollup 将 ES 导入语法转换为 require 语法。
      // 懒加载 Rollup（实际上在依赖项中）
      const code = await bundleConfigFile(resolvedPath)
      userConfig = await loadConfigFromBundledFile(resolvedPath, code)
      debug(`打包后的配置文件在 ${Date.now() - start}ms 内加载完成`)
    }

    const config =
      typeof userConfig === 'function' ? userConfig(configEnv) : userConfig
    if (!isObject(config)) {
      throw new Error(`配置必须导出或返回一个对象。`)
    }
    return {
      path: normalizePath(resolvedPath),
      config
    }
  } catch (e) {
    createLogger(logLevel).error(chalk.red(`从 ${resolvedPath} 加载配置失败`))
    throw e
  } finally {
    await stopService()
  }
}

async function bundleConfigFile(
  fileName: string,
  mjs = false
): Promise<string> {
  const rollup = require('rollup') as typeof Rollup
  // node-resolve must be imported since it's bundled
  const bundle = await rollup.rollup({
    external: (id: string) =>
      (id[0] !== '.' && !path.isAbsolute(id)) ||
      id.slice(-5, id.length) === '.json',
    input: fileName,
    treeshake: false,
    plugins: [
      // use esbuild + node-resolve to support .ts files
      esbuildPlugin({ target: 'esnext' }),
      resolvePlugin({
        root: path.dirname(fileName),
        isBuild: true,
        asSrc: false,
        isProduction: false
      }),
      {
        name: 'replace-import-meta',
        transform(code, id) {
          return code.replace(
            /\bimport\.meta\.url\b/g,
            JSON.stringify(`file://${id}`)
          )
        }
      }
    ]
  })

  const {
    output: [{ code }]
  } = await bundle.generate({
    exports: mjs ? 'auto' : 'named',
    format: mjs ? 'es' : 'cjs'
  })

  return code
}

interface NodeModuleWithCompile extends NodeModule {
  _compile(code: string, filename: string): any
}

/**
 * 异步从打包文件中加载用户配置。
 * 此函数动态修改扩展加载器以将指定的打包代码作为模块加载，然后恢复原始加载器。
 *
 * @param fileName - 打包文件的名称，用于确定文件扩展名和定位文件。
 * @param bundledCode - 要加载的打包代码字符串。
 * @returns 解析后的用户配置对象。
 */
async function loadConfigFromBundledFile(
  fileName: string,
  bundledCode: string
): Promise<UserConfig> {
  const extension = path.extname(fileName)
  const defaultLoader = require.extensions[extension]!

  // 修改当前文件扩展名的加载器，以便在加载指定文件时使用打包代码
  require.extensions[extension] = (module: NodeModule, filename: string) => {
    if (filename === fileName) {
      ;(module as NodeModuleWithCompile)._compile(bundledCode, filename)
    } else {
      defaultLoader(module, filename)
    }
  }

  // 清除缓存，以防服务器重启后加载旧的缓存
  delete require.cache[require.resolve(fileName)]

  const raw = require(fileName)
  const config = raw.__esModule ? raw.default : raw

  // 恢复原始的加载器
  require.extensions[extension] = defaultLoader

  return config
}

export function loadEnv(mode: string, root: string, prefix = 'VITE_') {
  if (mode === 'local') {
    throw new Error(
      `"local" cannot be used as a mode name because it conflicts with ` +
        `the .local postfix for .env files.`
    )
  }

  const env: Record<string, string> = {}
  const envFiles = [
    /** mode local file */ `.env.${mode}.local`,
    /** mode file */ `.env.${mode}`,
    /** local file */ `.env.local`,
    /** default file */ `.env`
  ]

  // check if there are actual env variables starting with VITE_*
  // these are typically provided inline and should be prioritized
  for (const key in process.env) {
    if (key.startsWith(prefix) && env[key] === undefined) {
      env[key] = process.env[key] as string
    }
  }

  for (const file of envFiles) {
    const path = lookupFile(root, [file], true)
    if (path) {
      const parsed = dotenv.parse(fs.readFileSync(path), {
        debug: !!process.env.DEBUG || undefined
      })

      // let environment variables use each other
      dotenvExpand({
        parsed,
        // prevent process.env mutation
        ignoreProcessEnv: true
      } as any)

      // only keys that start with prefix are exposed to client
      for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith(prefix) && env[key] === undefined) {
          env[key] = value
        } else if (key === 'NODE_ENV') {
          // NODE_ENV override in .env file
          process.env.VITE_USER_NODE_ENV = value
        }
      }
    }
  }

  return env
}
