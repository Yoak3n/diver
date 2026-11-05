// @diver/memory — 平台观察的“兴趣”提取与命中打分（纯逻辑 + 只读记忆）。
//
// 兴趣只来自主人侧：owner/global topics、实体、owner 笔记、显式配置。
// 不碰群聊/私聊/陌生人的记忆，保持“她自己想了解什么”是主人可解释的。

import { ownerNoteTexts } from './curiosity-sources.ts'
import { splitList } from './curiosity-platform-config.ts'
import type { PlatformCandidate } from './curiosity-platform-types.ts'
import type { MemoryStore } from './store-rpc.ts'

export interface InterestProfile {
  keywords: string[]
  /** 用于匿名搜索的短查询（最多 2 个）。 */
  queries: string[]
}

const META_TOPIC = /^(会话|闲聊|日常|寒暄|身份|探索|平台|用户|助手)/

/** 读 owner/global topics + 实体 + owner 笔记，合并显式兴趣。 */
export async function collectInterestProfile(
  store: MemoryStore,
  home: string,
  extra = '',
  limit = 40,
): Promise<InterestProfile> {
  const topics: string[] = []
  try {
    for (const row of await store.listTopics()) {
      if (row.scope !== 'owner' && row.scope !== 'global') continue
      topics.push(row.canonicalName)
    }
  } catch (err) {
    console.warn(`[platform] 读取 topics 失败: ${(err as Error)?.message ?? err}`)
  }
  const entities: string[] = []
  try {
    for (const row of await store.listEntities(200)) entities.push(row.name)
  } catch (err) {
    console.warn(`[platform] 读取实体失败: ${(err as Error)?.message ?? err}`)
  }
  const notes = ownerNoteTexts(home)
    .map((note) => note.text)
    .join('\n')
  return buildInterestProfile({ topics, entities, notes, extra }, limit)
}

/** 纯函数：从主人信号里抽关键词与搜索词。 */
export function buildInterestProfile(
  input: {
    topics: readonly string[]
    entities: readonly string[]
    notes?: string
    extra?: string
  },
  limit = 40,
): InterestProfile {
  const explicit = splitList(input.extra, 20, 20)
  const keywords: string[] = []
  const add = (text: string): void => {
    const value = text.trim()
    if (value.length < 2 || value.length > 20) return
    if (META_TOPIC.test(value)) return
    if (keywords.includes(value)) return
    keywords.push(value)
  }

  for (const item of explicit) add(item)
  for (const topic of input.topics) add(topic)
  for (const entity of input.entities) add(entity)
  // 笔记只取明确标记的内容（书名号/引号/反引号），避免整页噪声。
  for (const match of (input.notes ?? '').matchAll(/[《「“`]([^》」”`\n]{2,20})[》」”`]/g)) {
    const value = match[1]
    if (value !== undefined) add(value)
  }

  const queries = [...explicit, ...keywords].filter((item) => item.length >= 2 && item.length <= 20)
  return {
    keywords: keywords.slice(0, limit),
    queries: [...new Set(queries)].slice(0, 2),
  }
}

/** 标题命中权重 2，简介/标签/分区命中权重 1。 */
export function scoreCandidate(
  candidate: PlatformCandidate,
  keywords: readonly string[],
): { hits: number; matched: string[] } {
  const title = candidate.title.toLowerCase()
  const rest = `${candidate.description} ${candidate.tags.join(' ')} ${candidate.category}`.toLowerCase()
  let hits = 0
  const matched: string[] = []
  for (const keyword of keywords) {
    const key = keyword.toLowerCase()
    if (key === '') continue
    if (title.includes(key)) {
      hits += 2
      matched.push(keyword)
    } else if (rest.includes(key)) {
      hits += 1
      matched.push(keyword)
    }
  }
  return { hits, matched }
}
