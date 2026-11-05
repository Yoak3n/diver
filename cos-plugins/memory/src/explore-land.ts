// @diver/memory — 探索结果落地：摘要块组装 + 追加/新建 topic + 短 event。
//
// 设计取舍：
// - 落库用 append_topic_summary（保留旧状态），而不是 remember 的覆盖式 merge。
// - 有 fromMemoryId / 主题/词面命中的 topic 就追加；否则新建 episodic topic（owner）。
// - 平台见闻用 subject 做 topic 名，摘要带【平台见闻·B站】与来源链接。
// - 同时写一条短 event，让关系卡【今天】能看到“查了什么/看到了什么”。

import type { ExploreResult } from '@diver/web-tools/explore'

import { normalizeTerm } from './curiosity-extract.ts'
import type { Distilled } from './explore-distill.ts'
import type { MemoryStore, TopicRow } from './store-rpc.ts'

export type { Distilled } from './explore-distill.ts'
export { extractiveDistill, parseDistilled } from './explore-distill.ts'
export type { ExplorationSummarizer } from './explore-summarizer.ts'
export { createLlmSummarizer } from './explore-summarizer.ts'

/** 组装写进 topic 的摘要块（≤700 字）。 */
export function buildSummary(distilled: Distilled, result: ExploreResult, source?: string): string {
  const heading = source?.startsWith('platform:bilibili')
    ? '【平台见闻·B站】'
    : source?.startsWith('platform:')
      ? '【平台见闻】'
      : '【查到】'
  const lines = [`${heading}${distilled.oneLine}`]
  for (const point of distilled.points.slice(0, 3)) lines.push(`- ${point}`)
  if (distilled.perspective !== undefined && distilled.perspective !== '') {
    lines.push(`人群视角：${distilled.perspective}`)
  }
  const urls = uniqueUrls([
    ...result.pages.map((p) => p.url),
    ...result.hits.map((h) => h.url),
    ...extractUrls(result.summary),
  ]).slice(0, 3)
  if (urls.length > 0) lines.push(`来源：${urls.join(' ')}`)
  return lines.join('\n').slice(0, 700)
}

/** 写回：返回落地的 topic 与一句话结论。 */
export async function landExploration(
  store: MemoryStore,
  input: {
    term: string
    result: ExploreResult
    fromMemoryId?: string
    distilled: Distilled
    /** curiosity source；平台条目以 platform: 开头。 */
    source?: string
  },
): Promise<{ topicId: string; oneLine: string }> {
  const summary = buildSummary(input.distilled, input.result, input.source)
  const names = [input.distilled.subject, input.term].filter(
    (name): name is string => typeof name === 'string' && name.trim() !== '',
  )
  const target = await findTargetTopic(store, names, input.fromMemoryId)
  let topicId: string
  if (target !== undefined) {
    await store.appendTopicSummary(target, summary, 800)
    topicId = target
  } else {
    topicId = await store.createTopic({
      canonicalName: (names[0] ?? input.term).slice(0, 40),
      stateSummary: summary,
      tier: 'episodic',
      uncertain: false,
      scope: 'owner',
    })
  }
  try {
    await store.appendEvent({
      topicId,
      statement: `${input.source?.startsWith('platform:') ? '看到' : '查了'}「${names[0] ?? input.term}」：${input.distilled.oneLine}`.slice(0, 140),
    })
  } catch (err) {
    console.warn(`[explore] 写入 event 失败（不影响落地）: ${(err as Error)?.message ?? err}`)
  }
  return { topicId, oneLine: input.distilled.oneLine }
}

/** fromMemoryId 优先；否则按主题/词面精确匹配（含旧的「探索:词」），最后做包含匹配。 */
async function findTargetTopic(
  store: MemoryStore,
  names: readonly string[],
  fromMemoryId?: string,
): Promise<string | undefined> {
  if (fromMemoryId) {
    try {
      const row = await store.getTopic(fromMemoryId)
      if (row !== undefined) return row.id
    } catch {
      /* 记忆已被遗忘：继续找词面 */
    }
  }
  const keys = names.map((name) => normalizeTerm(name)).filter((key) => key !== '')
  let rows: TopicRow[] = []
  try {
    rows = await store.listTopics()
  } catch (err) {
    console.warn(`[explore] 读取 topics 失败: ${(err as Error)?.message ?? err}`)
  }
  const exact = rows.find(
    (row) =>
      (row.scope === 'owner' || row.scope === 'global') &&
      keys.some(
        (key) =>
          normalizeTerm(row.canonicalName) === key ||
          normalizeTerm(row.canonicalName) === normalizeTerm(`探索:${key}`),
      ),
  )
  if (exact !== undefined) return exact.id
  for (const name of names) {
    try {
      const hits = await store.blockingCandidates(name, 3, { scopes: ['owner'] })
      if (hits[0] !== undefined) return hits[0].id
    } catch {
      /* 继续尝试下一个名字 */
    }
  }
  return undefined
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.filter((url) => url.trim() !== ''))]
}

function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s<>"'）)]+/g) ?? []
}
