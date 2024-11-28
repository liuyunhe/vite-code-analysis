import { extname } from 'path'
import { isDirectCSSRequest } from '../plugins/css'
import {
  cleanUrl,
  normalizePath,
  removeImportQuery,
  removeTimestampQuery
} from '../utils'
import { TransformResult } from './transformRequest'
import { PluginContainer } from './pluginContainer'
import { parse as parseUrl } from 'url'

export class ModuleNode {
  /**
   * Public served url path, starts with /
   */
  url: string
  /**
   * Resolved file system path + query
   */
  id: string | null = null
  file: string | null = null
  type: 'js' | 'css'
  importers = new Set<ModuleNode>()
  importedModules = new Set<ModuleNode>()
  acceptedHmrDeps = new Set<ModuleNode>()
  isSelfAccepting = false
  transformResult: TransformResult | null = null
  ssrTransformResult: TransformResult | null = null
  ssrModule: Record<string, any> | null = null
  lastHMRTimestamp = 0

  constructor(url: string) {
    this.url = url
    this.type = isDirectCSSRequest(url) ? 'css' : 'js'
  }
}

function invalidateSSRModule(mod: ModuleNode, seen: Set<ModuleNode>) {
  if (seen.has(mod)) {
    return
  }
  seen.add(mod)
  mod.ssrModule = null
  mod.importers.forEach((importer) => invalidateSSRModule(importer, seen))
}
export class ModuleGraph {
  urlToModuleMap = new Map<string, ModuleNode>()
  idToModuleMap = new Map<string, ModuleNode>()
  // a single file may corresponds to multiple modules with different queries
  fileToModulesMap = new Map<string, Set<ModuleNode>>()
  container: PluginContainer

  constructor(container: PluginContainer) {
    this.container = container
  }

  async getModuleByUrl(rawUrl: string) {
    const [url] = await this.resolveUrl(rawUrl)
    return this.urlToModuleMap.get(url)
  }

  getModuleById(id: string) {
    return this.idToModuleMap.get(removeTimestampQuery(id))
  }

  getModulesByFile(file: string) {
    return this.fileToModulesMap.get(file)
  }

  onFileChange(file: string) {
    const mods = this.getModulesByFile(file)
    if (mods) {
      const seen = new Set<ModuleNode>()
      mods.forEach((mod) => {
        this.invalidateModule(mod, seen)
      })
    }
  }

  invalidateModule(mod: ModuleNode, seen: Set<ModuleNode> = new Set()) {
    mod.transformResult = null
    mod.ssrTransformResult = null
    invalidateSSRModule(mod, seen)
  }

  invalidateAll() {
    const seen = new Set<ModuleNode>()
    this.idToModuleMap.forEach((mod) => {
      this.invalidateModule(mod, seen)
    })
  }

  /**
   * Update the module graph based on a module's updated imports information
   * If there are dependencies that no longer have any importers, they are
   * returned as a Set.
   */

  /**
   * 异步更新模块信息。
   *
   * 此函数主要负责更新模块的导入关系和 HMR（热模块替换）依赖关系。
   * 它还管理不再被当前模块导入的模块。
   *
   * @param mod 当前模块节点，用于更新其导入和 HMR 关系。
   * @param importedModules 包含所有直接被当前模块导入的模块的集合。
   * @param acceptedModules 包含所有当前模块接受更改的模块（HMR 依赖）的集合。
   * @param isSelfAccepting 布尔值，表示模块是否接受自身的更改。
   * @returns 返回一个不再被当前模块导入的模块节点集合，如果有；否则返回 undefined。
   */

  async updateModuleInfo(
    mod: ModuleNode,
    importedModules: Set<string | ModuleNode>,
    acceptedModules: Set<string | ModuleNode>,
    isSelfAccepting: boolean
  ): Promise<Set<ModuleNode> | undefined> {
    // 设置mod的isSelfAccepting属性为指定的值
    mod.isSelfAccepting = isSelfAccepting

    // 保存当前模块的已导入模块集合
    const prevImports = mod.importedModules

    // 创建一个新的空集合，用于记录新的导入模块，并将其赋值给模块的importedModules属性
    const nextImports = (mod.importedModules = new Set())

    // 定义一个可选的集合，用于记录不再被导入的模块节点
    let noLongerImported: Set<ModuleNode> | undefined

    // 更新导入图
    for (const imported of importedModules) {
      const dep =
        typeof imported === 'string'
          ? await this.ensureEntryFromUrl(imported)
          : imported
      dep.importers.add(mod)
      nextImports.add(dep)
    }

    // 从不再被导入的依赖中移除导入者
    prevImports.forEach((dep) => {
      if (!nextImports.has(dep)) {
        dep.importers.delete(mod)
        if (!dep.importers.size) {
          // 依赖不再被导入
          ;(noLongerImported || (noLongerImported = new Set())).add(dep)
        }
      }
    })

    // 更新接受的 HMR 依赖
    const deps = (mod.acceptedHmrDeps = new Set())
    for (const accepted of acceptedModules) {
      const dep =
        typeof accepted === 'string'
          ? await this.ensureEntryFromUrl(accepted)
          : accepted
      deps.add(dep)
    }

    return noLongerImported
  }

  /**
   * 确保根据URL获取模块入口
   * 如果模块尚未加载，则进行加载并缓存
   *
   * @param rawUrl 原始URL，用于解析和获取模块信息
   * @returns 返回ModuleNode实例，表示模块入口
   */
  async ensureEntryFromUrl(rawUrl: string) {
    // 解析URL并获取模块的URL和解析后的ID
    const [url, resolvedId] = await this.resolveUrl(rawUrl)

    // 尝试从URL到模块的映射中获取模块实例
    let mod = this.urlToModuleMap.get(url)

    // 如果未找到模块实例，则创建并缓存它
    if (!mod) {
      mod = new ModuleNode(url)
      this.urlToModuleMap.set(url, mod)
      mod.id = resolvedId
      this.idToModuleMap.set(resolvedId, mod)

      // 清理URL以获取文件名，并创建文件到模块的映射
      const file = (mod.file = cleanUrl(resolvedId))
      let fileMappedModules = this.fileToModulesMap.get(file)

      // 如果文件没有映射到任何模块，则初始化映射
      if (!fileMappedModules) {
        fileMappedModules = new Set()
        this.fileToModulesMap.set(file, fileMappedModules)
      }

      // 将模块添加到文件到模块的映射中
      fileMappedModules.add(mod)
    }

    // 返回模块实例
    return mod
  }

  // some deps, like a css file referenced via @import, don't have its own
  // url because they are inlined into the main css import. But they still
  // need to be represented in the module graph so that they can trigger
  // hmr in the importing css file.

  // 一些依赖项，例如通过 @import 引用的 CSS 文件，没有自己的 URL，
  // 因为它们被内联到主 CSS 导入中。但是它们仍然需要在模块图中表示，
  // 以便可以在导入的 CSS 文件中触发 HMR（热模块替换）。

  /**
   * 创建一个仅包含文件条目的函数
   * 该函数用于确保给定的文件路径在映射中唯一存在，并与其对应的模块信息关联
   * 如果该文件已有关联的模块信息，则直接返回现有的模块信息；
   * 否则，创建新的模块信息并将其与该文件关联
   *
   * @param file 文件路径，将被标准化处理以确保路径格式一致性
   * @returns 返回与该文件关联的模块信息实例
   */
  createFileOnlyEntry(file: string) {
    // 标准化文件路径以确保路径格式一致性
    file = normalizePath(file)
    // 构造模块URL，确保其在虚拟文件系统中的唯一性
    const url = `/@fs/${file}`

    // 尝试获取与文件关联的模块集合
    let fileMappedModules = this.fileToModulesMap.get(file)
    if (!fileMappedModules) {
      // 如果文件尚未映射到任何模块，创建一个新的集合并建立映射
      fileMappedModules = new Set()
      this.fileToModulesMap.set(file, fileMappedModules)
    }

    // 遍历文件映射的模块，检查是否存在匹配的URL
    for (const m of fileMappedModules) {
      if (m.url === url) {
        // 如果找到匹配的模块信息，则直接返回
        return m
      }
    }

    // 如果没有找到匹配的模块信息，创建新的模块信息实例
    const mod = new ModuleNode(url)
    // 将文件路径与模块信息关联
    mod.file = file
    // 将新的模块信息添加到文件映射的集合中
    fileMappedModules.add(mod)

    // 返回新创建或找到的模块信息实例
    return mod
  }

  // for incoming urls, it is important to:
  // 1. remove the HMR timestamp query (?t=xxxx)
  // 2. resolve its extension so that urls with or without extension all map to
  // the same module

  /**
   * 对于传入的URL，重要的是：
   * 1. 移除HMR时间戳查询参数 (?t=xxxx)
   * 2. 解析其扩展名，以便有或没有扩展名的URL都能映射到同一个模块
   */

  /**
   * 异步解析URL，返回解析后的URL和ID
   * 此函数的目的是根据给定的URL，解析出最终的URL形式和其对应的资源ID
   * 它通过移除URL中的查询参数和时间戳，解析资源ID，并根据文件扩展名调整URL格式
   *
   * @param url {string} 需要解析的URL字符串
   * @returns {Promise<[string, string]>} 返回一个Promise，解析后的URL和资源ID的元组
   */
  async resolveUrl(url: string): Promise<[string, string]> {
    // 移除URL中的import查询参数和时间戳查询参数，以获取清洁的URL
    url = removeImportQuery(removeTimestampQuery(url))
    // 解析资源ID，如果解析失败则回退到原始URL
    const resolvedId = (await this.container.resolveId(url))?.id || url
    // 获取解析后ID的文件扩展名
    const ext = extname(cleanUrl(resolvedId))
    // 解析URL的各个部分，以便后续处理
    const { pathname, search, hash } = parseUrl(url)
    // 如果有文件扩展名且pathname不以该扩展名结尾，则调整URL格式
    if (ext && !pathname!.endsWith(ext)) {
      url = pathname + ext + (search || '') + (hash || '')
    }
    // 返回解析后的URL和资源ID
    return [url, resolvedId]
  }
}
