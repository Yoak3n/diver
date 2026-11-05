// @diver/memory — 平台候选选择（纯函数）。
//
// 打分 = 弹幕密度 + 兴趣命中 + 少量随机；再按分区去重、保留 serendipity 名额。
// 目标不是“最热”，而是“既有她关心的，也有她原本不会搜到的”。

import { scoreCandidate } from './curiosity-interest.ts'
import type { PlatformCandidate } from './curiosity-platform-types.ts'

export interface ScoredPlatformCandidate<T extends PlatformCandidate> {
  item: T
  score: number
  hits: number
  matched: string[]
}

export interface SelectPlatformOptions {
  keywords: readonly string[]
  perRun: number
  /** 0–100：给“零兴趣命中”的随机名额百分比。 */
  serendipity: number
  blockKeywords?: readonly string[]
  rand?: () => number
}

/** 过滤垃圾/广告 → 打分 → 分区去重 → serendipity → 取前 N。 */
export function selectPlatformCandidates<T extends PlatformCandidate>(
  items: readonly T[],
  opts: SelectPlatformOptions,
): ScoredPlatformCandidate<T>[] {
  const rand = opts.rand ?? Math.random
  const block = (opts.blockKeywords ?? [])
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== '')
  const scored: Array<ScoredPlatformCandidate<T>> = []

  for (const item of items) {
    const haystack = `${item.title} ${item.description}`.toLowerCase()
    if (block.some((word) => haystack.includes(word))) continue
    const { hits, matched } = scoreCandidate(item, opts.keywords)
    if (item.view < 300 && item.danmaku < 3 && hits < 2) continue
    const density = 3 * Math.log10(1 + item.danmaku / Math.max(30, item.duration || 30))
    scored.push({ item, score: density + hits * 4 + rand() * 0.5, hits, matched })
  }
  scored.sort((a, b) => b.score - a.score)

  const perRun = Math.max(0, Math.min(5, Math.trunc(opts.perRun)))
  if (perRun === 0) return []
  const serendipitySlots = Math.min(
    perRun - 1,
    Math.round((perRun * Math.max(0, Math.min(80, opts.serendipity))) / 100),
  )
  const picked: Array<ScoredPlatformCandidate<T>> = []
  const pickedIds = new Set<string>()
  const take = (candidate: ScoredPlatformCandidate<T>): void => {
    if (pickedIds.has(candidate.item.id)) return
    pickedIds.add(candidate.item.id)
    picked.push(candidate)
  }

  // 先给“完全没命中兴趣”的候选留名额，避免只刷同温层。
  for (const candidate of scored) {
    if (picked.length >= serendipitySlots) break
    if (candidate.hits === 0) take(candidate)
  }
  // 再按分区去重取高分。
  const categories = new Set<string>()
  for (const candidate of scored) {
    if (picked.length >= perRun) break
    if (pickedIds.has(candidate.item.id)) continue
    const category = candidate.item.category || 'other'
    if (categories.has(category)) continue
    categories.add(category)
    take(candidate)
  }
  // 最后补满。
  for (const candidate of scored) {
    if (picked.length >= perRun) break
    take(candidate)
  }
  return picked.slice(0, perRun)
}
