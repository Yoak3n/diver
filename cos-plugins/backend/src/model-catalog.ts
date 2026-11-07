// @diver/backend — 模型目录快照（advisory，零网络读面 + 后台刷新）。
//
// /api/settings 是设置面板首屏的关键路径：适配器的 listModels() 会实时访问各家
// 上游（单家超时可达数秒），串行叠加会把「提供商卡片」一直拖到请求返回才出现。
// 因此这里维护一份快照：
//   - snapshot()  零网络，GET /api/settings 直接带出上次结果；
//   - refresh()   异步补齐（并发去重 + 最短间隔节流），GET /api/models 显式等待；
//   - 单个 provider 失败时保留其旧条目——目录只是候选列表，不能用空列表冲掉
//     已知值，也不能让一家的超时抹掉其它家的结果。
// @module @diver/backend/model-catalog

export interface ModelEntry {
  provider: string
  id: string
}

/** 只依赖注册表读面的最小接口（ctx.llm 结构上满足；单测可直接构造假实现）。 */
export interface ModelCatalogSource {
  listProviders(): Array<{ id: string }>
  listModels(provider: string): Promise<readonly string[]>
}

export interface ModelCatalog {
  /** 最近一次刷新结果（拷贝，零网络）。 */
  snapshot(): ModelEntry[]
  /** 刷新目录：并发去重；force=false 时受最短间隔节流。永不 reject。 */
  refresh(options?: { force?: boolean }): Promise<ModelEntry[]>
}

/** 非强制刷新的最短间隔：设置页挂载、侧栏事件、重启轮询都会触发。 */
const DEFAULT_MIN_INTERVAL_MS = 30_000

export function createModelCatalog(
  source: ModelCatalogSource,
  options: { minIntervalMs?: number } = {},
): ModelCatalog {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  let snapshot: ModelEntry[] = []
  let lastAttemptAt = 0
  let inflight: Promise<ModelEntry[]> | null = null

  function groupByProvider(entries: readonly ModelEntry[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>()
    for (const entry of entries) {
      const list = grouped.get(entry.provider)
      if (list !== undefined) list.push(entry.id)
      else grouped.set(entry.provider, [entry.id])
    }
    return grouped
  }

  async function fetchAll(): Promise<ModelEntry[]> {
    const providers = source.listProviders().map((provider) => provider.id)
    // 并行拉取：串行会让最慢一家的超时叠加到后面每一家之前。
    const results = await Promise.allSettled(providers.map((id) => source.listModels(id)))
    const previous = groupByProvider(snapshot)
    const next: ModelEntry[] = []
    providers.forEach((provider, index) => {
      const result = results[index]
      // 该 provider 本轮失败：沿用旧快照；从没成功过则留空（下拉退回适配器兜底）。
      const models =
        result?.status === 'fulfilled' ? result.value : (previous.get(provider) ?? [])
      for (const id of models) next.push({ provider, id })
    })
    return next
  }

  return {
    snapshot: () => [...snapshot],
    refresh(options = {}) {
      if (inflight !== null) return inflight
      const now = Date.now()
      if (options.force !== true && now - lastAttemptAt < minIntervalMs) {
        return Promise.resolve([...snapshot])
      }
      lastAttemptAt = now
      inflight = (async () => {
        try {
          snapshot = await fetchAll()
        } catch {
          // listProviders 等整体失败：保留旧快照，下次再试
        }
        return [...snapshot]
      })().finally(() => {
        inflight = null
      })
      return inflight
    },
  }
}
