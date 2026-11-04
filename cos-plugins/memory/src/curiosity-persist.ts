// @diver/memory — 候选落库（顺序 RPC；单条失败只告警）。

import type { CuriosityCandidate } from './curiosity-sources.ts'
import type { MemoryStore } from './store-rpc.ts'

/** 把扫描/订阅产出的候选写入队列；返回写入尝试成功的条数。 */
export async function persistCandidates(
  store: MemoryStore,
  candidates: readonly CuriosityCandidate[],
): Promise<number> {
  let added = 0
  for (const item of candidates) {
    try {
      await store.curiosityUpsert({
        term: item.term,
        source: item.source,
        reason: item.reason,
        priority: item.priority,
        ...(item.note ? { note: item.note } : {}),
        ...(item.payload ? { payload: item.payload } : {}),
        ...(item.dedupeKey ? { dedupeKey: item.dedupeKey } : {}),
      })
      added += 1
    } catch (err) {
      console.warn(`[curiosity] 入队「${item.term}」失败: ${(err as Error)?.message ?? err}`)
    }
  }
  return added
}
