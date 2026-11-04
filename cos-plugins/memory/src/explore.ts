// @diver/memory — Explore 取词面（设计 §7.4）。
//
// 控制面在壳（ExplorePolicy 裁决时机与词）；本模块只做候选合并：
// - 好奇心队列优先（群聊/笔记/实体/订阅攒出来的条目）
// - 不足时补记忆 topics（高频 / 近期 / 未确定）
// - 队列为空时按需触发一次取词扫描，避免壳端反复「无候选」空转
//
// job 生命周期（单飞 / cancel / 落库）在 ./explore-job.ts。

import type { MemoryStore } from './store-rpc.ts'
import type { ExploreCandidate } from './explore-types.ts'

/**
 * 队列为空时的按需取词钩子：由插件 apply 时注入（群聊/笔记/实体扫描）。
 * 放在模块级而不是直接 import runtime，避免 explore ↔ runtime 循环依赖。
 */
let refreshCuriosity: (() => Promise<void>) | null = null

export function setCuriosityRefresh(fn: (() => Promise<void>) | null): void {
  refreshCuriosity = fn
}

/**
 * 挑探索候选：好奇心队列优先，不足时补记忆 topics。
 */
export async function pickTerms(store: MemoryStore, limit = 5): Promise<ExploreCandidate[]> {
  const out: ExploreCandidate[] = []
  const seen = new Set<string>()
  let queue = await pickCuriosity(store, limit)
  if (queue.length === 0 && refreshCuriosity !== null) {
    try {
      await refreshCuriosity()
    } catch (err) {
      console.warn(`[explore] 取词扫描失败: ${(err as Error)?.message ?? err}`)
    }
    queue = await pickCuriosity(store, limit)
  }
  for (const item of queue) {
    const key = item.term.trim().toLowerCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  if (out.length < limit) {
    for (const item of await pickTopicTerms(store, limit - out.length)) {
      const key = item.term.trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out.slice(0, limit)
}

/** 队列候选：RPC 失败时返回空（旧壳/旧库不阻塞 topic 兜底）。 */
async function pickCuriosity(store: MemoryStore, limit: number): Promise<ExploreCandidate[]> {
  try {
    const rows = await store.curiosityPick(limit)
    return rows.map((row) => ({
      id: row.topicId ?? '',
      term: row.term,
      score: row.score,
      nTimes: row.occurrences,
      stateSummary: (row.note ?? '').slice(0, 120),
      reason:
        row.source.startsWith('subscription:') || row.reason === 'release' || row.reason === 'watch'
          ? 'subscription'
          : 'curiosity',
      curiosityId: row.id,
      source: row.source,
    }))
  } catch (err) {
    console.warn(`[explore] 读取好奇心队列失败: ${(err as Error)?.message ?? err}`)
    return []
  }
}

/** topics 兜底候选（原逻辑）。 */
async function pickTopicTerms(store: MemoryStore, limit: number): Promise<ExploreCandidate[]> {
  if (limit <= 0) return []
  const rows = await store.listTopics()
  const now = Date.now()
  const scored: ExploreCandidate[] = []
  for (const row of rows) {
    if (row.demotedAt) continue
    // topics 兜底只取主人/全局作用域：群聊/陌生人私聊的 topic 不复制进 owner。
    if (row.scope !== 'owner' && row.scope !== 'global') continue
    const term = (row.canonicalName ?? '').trim()
    if (term.length < 2 || term.length > 40) continue
    // 过滤纯寒暄/元话题
    if (/^(会话|闲聊|日常|寒暄|身份|探索)/.test(term)) continue

    const recency = Math.max(0, 1 - (now - row.lastDiscussedAt) / (30 * 24 * 3600_000))
    let reason: ExploreCandidate['reason'] = 'high_frequency'
    let score = row.weight * (1 + Math.min(row.nTimes, 10) * 0.1) * (0.4 + 0.6 * recency)
    if (row.uncertain) {
      reason = 'uncertain'
      score *= 1.3
    } else if (recency > 0.7) {
      reason = 'recent'
      score *= 1.1
    }
    if (row.nTimes < 2 && !row.uncertain) continue
    scored.push({
      id: row.id,
      term,
      score,
      nTimes: row.nTimes,
      stateSummary: (row.stateSummary ?? '').slice(0, 120),
      reason,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

export { ExploreJobManager, exploreJobs } from './explore-job.ts'
export type { ExploreCandidate, ExploreJobStatus, ExploreInput } from './explore-types.ts'
export type { ExploreResult } from './explore-types.ts'
export type { TopicRow } from './store-rpc.ts'
