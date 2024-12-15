import { ViteDevServer } from '..'
import { Connect } from 'types/connect'
import {
  cleanUrl,
  createDebugger,
  injectQuery,
  isImportRequest,
  isJSRequest,
  prettifyUrl,
  removeImportQuery,
  removeTimestampQuery
} from '../../utils'
import { send } from '../send'
import { transformRequest } from '../transformRequest'
import { isHTMLProxy } from '../../plugins/html'
import chalk from 'chalk'
import {
  CLIENT_PUBLIC_PATH,
  DEP_CACHE_DIR,
  DEP_VERSION_RE,
  NULL_BYTE_PLACEHOLDER,
  VALID_ID_PREFIX
} from '../../constants'
import { isCSSRequest, isDirectCSSRequest } from '../../plugins/css'

const debugCache = createDebugger('vite:cache')
const isDebug = !!process.env.DEBUG

const knownIgnoreList = new Set(['/', '/favicon.ico'])

/**
 * 创建一个中间件函数，用于处理和转换传入请求。
 * 主要目的是根据请求的URL和类型，决定是否进行资源的转换和传输。
 *
 * @param server Vite开发服务器实例，用于访问配置和模块图。
 * @returns 返回一个中间件函数，用于处理HTTP请求。
 */
export function transformMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  // 从服务器实例中解构出配置和模块图。
  const {
    config: { root, logger },
    moduleGraph
  } = server

  // 返回一个异步中间件函数。
  return async (req, res, next) => {
    // 忽略非GET请求、HTML请求和已知的忽略项。
    if (
      req.method !== 'GET' ||
      req.headers.accept?.includes('text/html') ||
      knownIgnoreList.has(req.url!)
    ) {
      return next()
    }

    // 如果有未完成的重载且请求不是Vite客户端请求，则等待重载完成。
    if (
      server._pendingReload &&
      // always allow vite client requests so that it can trigger page reload
      !req.url?.startsWith(CLIENT_PUBLIC_PATH) &&
      !req.url?.includes('vite/dist/client')
    ) {
      // missing dep pending reload, hold request until reload happens
      server._pendingReload.then(() => res.end())
      return
    }

    // 解码和清理请求URL。
    let url = decodeURI(removeTimestampQuery(req.url!)).replace(
      NULL_BYTE_PLACEHOLDER,
      '\0'
    )
    const withoutQuery = cleanUrl(url)

    try {
      // 检查是否为源码映射请求。
      const isSourceMap = withoutQuery.endsWith('.map')
      // 处理源码映射请求。
      if (isSourceMap) {
        const originalUrl = url.replace(/\.map($|\?)/, '$1')
        const map = (await moduleGraph.getModuleByUrl(originalUrl))
          ?.transformResult?.map
        if (map) {
          return send(req, res, JSON.stringify(map), 'json')
        } else {
          return next()
        }
      }

      // 对/public/路径发出警告。
      if (url.startsWith('/public/')) {
        logger.warn(
          chalk.yellow(
            `files in the public directory are served at the root path.\n` +
              `Instead of ${chalk.cyan(url)}, use ${chalk.cyan(
                url.replace(/^\/public\//, '/')
              )}.`
          )
        )
      }

      // 处理JS、导入、CSS和HTML代理请求。
      if (
        isJSRequest(url) ||
        isImportRequest(url) ||
        isCSSRequest(url) ||
        isHTMLProxy(url)
      ) {
        // 移除?import查询。
        url = removeImportQuery(url)

        // 移除有效的ID前缀。
        if (url.startsWith(VALID_ID_PREFIX)) {
          url = url.slice(VALID_ID_PREFIX.length)
        }

        // 对于CSS请求，区分普通请求和导入请求。
        if (isCSSRequest(url) && req.headers.accept?.includes('text/css')) {
          url = injectQuery(url, 'direct')
        }

        // 检查是否可以早期返回304。
        const ifNoneMatch = req.headers['if-none-match']
        if (
          ifNoneMatch &&
          (await moduleGraph.getModuleByUrl(url))?.transformResult?.etag ===
            ifNoneMatch
        ) {
          isDebug && debugCache(`[304] ${prettifyUrl(url, root)}`)
          res.statusCode = 304
          return res.end()
        }

        // 使用插件容器解析、加载和转换请求。
        const result = await transformRequest(url, server)
        if (result) {
          const type = isDirectCSSRequest(url) ? 'css' : 'js'
          const isDep =
            DEP_VERSION_RE.test(url) ||
            url.includes(`node_modules/${DEP_CACHE_DIR}`)
          return send(
            req,
            res,
            result.code,
            type,
            result.etag,
            // 允许浏览器缓存npm依赖项！
            isDep ? 'max-age=31536000,immutable' : 'no-cache',
            result.map
          )
        }
      }
    } catch (e) {
      return next(e)
    }

    // 如果请求未被处理，则调用next函数。
    next()
  }
}
