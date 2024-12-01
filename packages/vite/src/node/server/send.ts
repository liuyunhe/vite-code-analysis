import { IncomingMessage, ServerResponse } from 'http'
import getEtag from 'etag'
import { SourceMap } from 'rollup'

// 根据环境变量确定是否启用调试模式
const isDebug = process.env.DEBUG

// 定义文件扩展名到MIME类型的映射
const alias: Record<string, string | undefined> = {
  js: 'application/javascript',
  css: 'text/css',
  html: 'text/html',
  json: 'application/json'
}

/**
 * 发送HTTP响应，包含指定的内容和内容类型
 * @param req HTTP请求对象
 * @param res HTTP响应对象
 * @param content 要发送的内容，可以是字符串或Buffer
 * @param type 内容类型，例如 'js', 'css' 等
 * @param etag ETag值，默认使用 `getEtag` 生成
 * @param cacheControl 缓存控制头，默认为 'no-cache'
 * @param map 源代码映射，可选
 */
export function send(
  req: IncomingMessage,
  res: ServerResponse,
  content: string | Buffer,
  type: string,
  etag = getEtag(content, { weak: true }),
  cacheControl = 'no-cache',
  map?: SourceMap | null
) {
  // 如果请求头中的If-None-Match与ETag匹配，则返回304状态码
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304
    return res.end()
  }

  // 设置响应头
  res.setHeader('Content-Type', alias[type] || type)
  res.setHeader('Cache-Control', cacheControl)
  res.setHeader('Etag', etag)

  // 注入源代码映射引用
  if (map && map.mappings) {
    if (isDebug) {
      content += `\n/*${JSON.stringify(map, null, 2).replace(
        /\*\//g,
        '*\\/'
      )}*/\n`
    }
    content += genSourceMapString(map)
  }

  // 发送响应内容
  res.statusCode = 200
  return res.end(content)
}

/**
 * 生成源代码映射字符串
 * @param map 源代码映射对象或字符串
 * @returns 源代码映射字符串
 */
function genSourceMapString(map: SourceMap | string | undefined) {
  if (typeof map !== 'string') {
    map = JSON.stringify(map)
  }
  return `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(
    map
  ).toString('base64')}`
}
