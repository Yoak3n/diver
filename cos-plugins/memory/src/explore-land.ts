// @diver/memory — 探索结果落地：LLM 提炼 + 写回 topics。
//
// 设计取舍：
// - 优先让当前模型压成「1 句结论 + ≤3 条要点」；失败/关闭时退回首句摘录。
// - 落库用 append_topic_summary（保留旧状态），而不是 remember 的覆盖式 merge。
// - 有 fromMemoryId / 词面命中的 topic 就追加；否则新建 episodic topic（owner）。
// - 同时写一条短 event，让关系卡【今天】能看到“查了什么”。

import type { Context } from 'cordis'
import { SessionId } from '@cos/plugin-api'
import type { ExploreResult } from '@diver/web-tools/explore'

import { normalizeTerm } from './curiosity-extract.ts'
import { readDiverSettings, SESSION_ID } from './session.ts'
import type { MemoryStore, TopicRow } from './store-rpc.ts'

export interface Distilled {
  /** 一句话结论（≤120 字，汇报也用这一句）。 */
  oneLine: string
  /** ≤3 条要点。 */
  points: string[]
}

export type ExplorationSummarizer = (input: {
  term: string
  result: ExploreResult
}) => Promise<Distilled | null>

/** 无 LLM 时的兜底：取页面/搜索片段的首句。 */
export function extractiveDistill(term: string, result: ExploreResult): Distilled {
  // 订阅 payload：没有 pages/hits，正文就在 summary 里。
  if (result.pages.length === 0 && result.hits.length === 0 && result.summary.trim() !== '') {
    const sentences = firstSentences(result.summary, 4)
    return {
      oneLine: (sentences[0] ?? `关于「${term}」的更新`).slice(0, 120),
      points: sentences.slice(1, 4).map((s) => s.slice(0, 80)),
    }
  }
  const page = result.pages.find((p) => !p.error && p.excerpt.trim() !== '')
  const first = page !== undefined ? firstSentences(page.excerpt, 2).join(' ') : ''
  const snippet = result.hits.find((h) => h.snippet.trim() !== '')?.snippet ?? ''
  const oneLine = (first || firstSentences(snippet, 1)[0] || `关于「${term}」的检索结果`).slice(0, 120)

  const points: string[] = []
  for (const p of result.pages) {
    if (p.error) continue
    const sentence = firstSentences(p.excerpt, 1)[0]
    if (sentence !== undefined && sentence !== '' && sentence !== oneLine) points.push(sentence.slice(0, 80))
    if (points.length >= 3) break
  }
  if (points.length === 0) {
    for (const hit of result.hits.slice(0, 3)) {
      const sentence = firstSentences(hit.snippet, 1)[0]
      if (sentence !== undefined && sentence !== '') points.push(sentence.slice(0, 80))
    }
  }
  return { oneLine, points: points.slice(0, 3) }
}

/** 组装写进 topic 的摘要块（≤700 字）。 */
export function buildSummary(distilled: Distilled, result: ExploreResult): string {
  const lines = [`【查到】${distilled.oneLine}`]
  for (const point of distilled.points.slice(0, 3)) lines.push(`- ${point}`)
  const urls = uniqueUrls([
    ...result.pages.map((p) => p.url),
    ...result.hits.map((h) => h.url),
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
  },
): Promise<{ topicId: string; oneLine: string }> {
  const summary = buildSummary(input.distilled, input.result)
  const target = await findTargetTopic(store, input.term, input.fromMemoryId)
  let topicId: string
  if (target !== undefined) {
    await store.appendTopicSummary(target, summary, 800)
    topicId = target
  } else {
    topicId = await store.createTopic({
      canonicalName: input.term.slice(0, 40),
      stateSummary: summary,
      tier: 'episodic',
      uncertain: false,
      scope: 'owner',
    })
  }
  try {
    await store.appendEvent({
      topicId,
      statement: `查了「${input.term}」：${input.distilled.oneLine}`.slice(0, 140),
    })
  } catch (err) {
    console.warn(`[explore] 写入 event 失败（不影响落地）: ${(err as Error)?.message ?? err}`)
  }
  return { topicId, oneLine: input.distilled.oneLine }
}

/** fromMemoryId 优先；否则按词面精确匹配（含旧的「探索:词」），最后做包含匹配。 */
async function findTargetTopic(
  store: MemoryStore,
  term: string,
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
  const key = normalizeTerm(term)
  let rows: TopicRow[] = []
  try {
    rows = await store.listTopics()
  } catch (err) {
    console.warn(`[explore] 读取 topics 失败: ${(err as Error)?.message ?? err}`)
  }
  const exact = rows.find(
    (row) =>
      (row.scope === 'owner' || row.scope === 'global') &&
      (normalizeTerm(row.canonicalName) === key ||
        normalizeTerm(row.canonicalName) === normalizeTerm(`探索:${term}`)),
  )
  if (exact !== undefined) return exact.id
  try {
    const hits = await store.blockingCandidates(term, 3, { scopes: ['owner'] })
    return hits[0]?.id
  } catch {
    return undefined
  }
}

/** 当前模型路由（跟随设置；缺省第一个适配器），与 digest worker 一致。 */
async function resolveRoute(ctx: Context): Promise<{ provider: string; model: string }> {
  const settings = readDiverSettings()
  const provider =
    typeof settings.provider === 'string' && settings.provider !== ''
      ? settings.provider
      : (ctx.llm.listProviders()[0]?.id ?? '')
  const model =
    typeof settings.model === 'string' && settings.model !== ''
      ? settings.model
      : provider === ''
        ? ''
        : ((await ctx.llm.listModels(provider))[0] ?? '')
  return { provider, model }
}

/** 用当前模型提炼；任何失败返回 null，由调用方退回 extractiveDistill。 */
export function createLlmSummarizer(ctx: Context): ExplorationSummarizer {
  return async ({ term, result }) => {
    const { provider, model } = await resolveRoute(ctx)
    if (provider === '' || model === '') return null
    const material = [
      `词：${term}`,
      // 订阅 payload 没有 pages/hits：正文在 summary 里。
      ...(result.pages.length === 0 && result.hits.length === 0 && result.summary.trim() !== ''
        ? [`材料：\n${result.summary.slice(0, 5000)}`]
        : []),
      ...result.pages.slice(0, 3).map((p) => `页面 ${p.url}\n${p.excerpt.slice(0, 1500)}`),
      ...result.hits.slice(0, 4).map((h) => `搜索 ${h.title}\n${h.snippet}`),
    ].join('\n\n').slice(0, 6000)
    const prompt = [
      '你在帮一个陪伴型 AI 把一次外部探索整理成长期记忆。',
      '只输出 2–4 行，不要解释、不要标题：',
      '第 1 行：一句话结论（≤60 字，中文，说清“是什么/有什么变化”）。',
      '之后最多 3 行：以 "- " 开头的要点（每条 ≤50 字）。',
      '禁止编造材料里没有的事实；材料不足就只输出第 1 行。',
      '',
      '材料：',
      material,
    ].join('\n')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    let raw = ''
    try {
      for await (const chunk of ctx.llm.stream({
        provider,
        model,
        maxTokens: 320,
        sessionId: SessionId(SESSION_ID),
        signal: controller.signal,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      })) {
        if (chunk.type === 'text-delta') raw += chunk.text
      }
    } catch (err) {
      console.warn(`[explore] LLM 提炼失败，退回摘录: ${(err as Error)?.message ?? err}`)
      return null
    } finally {
      clearTimeout(timer)
    }
    return parseDistilled(raw)
  }
}

/** 解析模型输出：优先 JSON，其次「结论 + - 要点」纯文本。 */
export function parseDistilled(raw: string): Distilled | null {
  const text = raw.trim()
  if (text === '') return null
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as { oneLine?: unknown; points?: unknown }
      const oneLine = typeof obj.oneLine === 'string' ? obj.oneLine.trim() : ''
      const points = Array.isArray(obj.points)
        ? obj.points.filter((p): p is string => typeof p === 'string' && p.trim() !== '').slice(0, 3)
        : []
      if (oneLine !== '') return { oneLine: oneLine.slice(0, 120), points }
    } catch {
      /* 落回文本解析 */
    }
  }
  const lines = text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return null
  const first = stripBullet(lines[0]!).replace(/^结论[:：]\s*/, '').trim()
  if (first.length < 2) return null
  const points = lines
    .slice(1)
    .filter((line) => /^[-*•]/.test(line) || /^\d+[.、]/.test(line))
    .map(stripBullet)
    .filter((line) => line !== '')
    .slice(0, 3)
  return { oneLine: first.slice(0, 120), points }
}

function stripBullet(line: string): string {
  return line.replace(/^[-*•]\s*/, '').replace(/^\d+[.、]\s*/, '').trim()
}

function firstSentences(text: string, n: number): string[] {
  return text
    .replace(/^#.*$/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    // 中文句号直接断句；英文句点只在后跟空白/结尾时断（避免拆开 v0.2.14）。
    .split(/(?<=[。！？])|(?<=[.!?])(?=\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, n)
}

function uniqueUrls(urls: string[]): string[] {
  return [...new Set(urls.filter((url) => url.trim() !== ''))]
}
