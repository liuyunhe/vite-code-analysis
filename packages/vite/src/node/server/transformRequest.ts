import { promises as fs } from 'fs'
import path from 'path'
import getEtag from 'etag'
import * as convertSourceMap from 'convert-source-map'
import { SourceDescription, SourceMap } from 'rollup'
import { ViteDevServer } from '..'
import chalk from 'chalk'
import {
  createDebugger,
  cleanUrl,
  prettifyUrl,
  removeTimestampQuery,
  timeFrom,
  ensureWatchedFile
} from '../utils'
import { checkPublicFile } from '../plugins/asset'
import { ssrTransform } from '../ssr/ssrTransform'

const debugLoad = createDebugger('vite:load')
const debugTransform = createDebugger('vite:transform')
const debugCache = createDebugger('vite:cache')
const isDebug = !!process.env.DEBUG

export interface TransformResult {
  code: string
  map: SourceMap | null
  etag?: string
  deps?: string[]
}

export interface TransformOptions {
  ssr?: boolean
}

/**
 * 异步转换请求为模块。
 *
 * 该函数主要负责将请求的资源转换为 Vite 可识别的模块格式。
 * 它首先检查是否有可用的缓存模块；如果有，直接返回缓存结果。
 * 如果没有缓存，则解析请求的 URL，并尝试从文件系统或插件加载代码。
 * 加载成功后，确保模块图中存在该模块，并对其进行转换。
 * 最后，根据是否为 SSR 模式返回相应的转换结果。
 *
 * @param url - 请求的 URL
 * @param viteDevServer - 包含配置、插件容器、模块图和监视器的 Vite 开发服务器对象
 * @param options - 转换选项，默认为空对象
 * @returns 转换结果或 null
 */
export async function transformRequest(
  url: string,
  { config, pluginContainer, moduleGraph, watcher }: ViteDevServer,
  options: TransformOptions = {}
): Promise<TransformResult | null> {
  // 移除 URL 中的时间戳查询参数
  url = removeTimestampQuery(url)

  // 获取配置和日志记录器
  const { root, logger } = config

  // 在调试模式下美化 URL
  const prettyUrl = isDebug ? prettifyUrl(url, root) : ''

  // 检查是否为 SSR 模式
  const ssr = !!options.ssr

  // 检查是否有新鲜的缓存
  const module = await moduleGraph.getModuleByUrl(url)
  const cached =
    module && (ssr ? module.ssrTransformResult : module.transformResult)
  if (cached) {
    isDebug && debugCache(`[memory] ${prettyUrl}`)
    return cached
  }

  // 解析请求的 URL
  const id = (await pluginContainer.resolveId(url))?.id || url
  const file = cleanUrl(id)

  // 初始化代码和源映射
  let code: string | null = null
  let map: SourceDescription['map'] = null

  // 加载代码
  const loadStart = isDebug ? Date.now() : 0
  const loadResult = await pluginContainer.load(id, ssr)
  if (loadResult == null) {
    // 尝试从文件系统作为字符串加载
    try {
      code = await fs.readFile(file, 'utf-8')
      isDebug && debugLoad(`${timeFrom(loadStart)} [fs] ${prettyUrl}`)
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e
      }
    }
    if (code) {
      try {
        map = (
          convertSourceMap.fromSource(code) ||
          convertSourceMap.fromMapFileSource(code, path.dirname(file))
        )?.toObject()
      } catch (e) {
        logger.warn(`Failed to load source map for ${url}.`, {
          timestamp: true
        })
      }
    }
  } else {
    isDebug && debugLoad(`${timeFrom(loadStart)} [plugin] ${prettyUrl}`)
    if (typeof loadResult === 'object') {
      code = loadResult.code
      map = loadResult.map
    } else {
      code = loadResult
    }
  }

  // 如果代码为空且文件在 public 目录中，抛出错误
  if (code == null) {
    if (checkPublicFile(url, config)) {
      throw new Error(
        `Failed to load url ${url} (resolved id: ${id}). ` +
          `This file is in /public and will be copied as-is during build without ` +
          `going through the plugin transforms, and therefore should not be ` +
          `imported from source code. It can only be referenced via HTML tags.`
      )
    } else {
      return null
    }
  }

  // 确保模块图中存在该模块
  const mod = await moduleGraph.ensureEntryFromUrl(url)
  ensureWatchedFile(watcher, mod.file, root)

  // 转换代码
  const transformStart = isDebug ? Date.now() : 0
  const transformResult = await pluginContainer.transform(code, id, map, ssr)
  if (
    transformResult == null ||
    (typeof transformResult === 'object' && transformResult.code == null)
  ) {
    // 没有应用转换，保持代码不变
    isDebug &&
      debugTransform(
        timeFrom(transformStart) + chalk.dim(` [skipped] ${prettyUrl}`)
      )
  } else {
    isDebug && debugTransform(`${timeFrom(transformStart)} ${prettyUrl}`)
    code = transformResult.code!
    map = transformResult.map
  }

  // 返回转换结果
  if (ssr) {
    return (mod.ssrTransformResult = await ssrTransform(code, map as SourceMap))
  } else {
    return (mod.transformResult = {
      code,
      map,
      etag: getEtag(code, { weak: true })
    } as TransformResult)
  }
}
