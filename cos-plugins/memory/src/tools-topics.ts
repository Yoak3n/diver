// @diver/memory — 工具面（话题记忆）：remember / recall / inventory / demote。
// harness 的 ctx.tools.register(name, executor, options)：executor 返回
// { content: string }，结构化结果序列化为 JSON 字符串。

import type { Context } from 'cordis'
// Load Cordis Context service-key declarations (ctx.tools …).
import type {} from '@cos/plugin-api'

import type { MemoryStore, TopicRow } from './store-rpc.ts'
import { humanWhen } from './timefmt.ts'
import {
  allowsEntities,
  isOtherGroupScope,
  isRawScope,
  recallPolicy,
  scopeFilter,
  writeScope,
  type RecallPolicy,
} from './turn-scope.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function scoreTopic(row: TopicRow, now: number): number {
  const recency = Math.max(0, 1 - (now - row.lastDiscussedAt) / (30 * DAY_MS))
  const activation = 1 + Math.min(row.activationCount, 10) * 0.1
  return row.weight * activation * (0.4 + 0.6 * recency)
}

function confidenceOf(score: number): 'high' | 'medium' | 'low' {
  return score > 0.7 ? 'high' : score > 0.4 ? 'medium' : 'low'
}

function toResult(row: TopicRow, score: number): Record<string, unknown> {
  return {
    topic: row.canonicalName,
    state: row.stateSummary,
    when: humanWhen(row.lastDiscussedAt),
    nTimes: row.nTimes,
    confidence: confidenceOf(score),
  }
}

/** 其他群的记忆只给轮廓：不给 state，避免细节进入本群上下文。 */
function toFuzzyResult(row: TopicRow): Record<string, unknown> {
  return {
    topic: row.canonicalName,
    state: '（其他群聊过相关话题；细节不在本群展开）',
    when: humanWhen(row.lastDiscussedAt),
    nTimes: row.nTimes,
    confidence: 'low',
    fuzzy: true,
  }
}

function rawRecent(store: MemoryStore, policy: RecallPolicy, limit: number): TopicRow[] {
  return store.recentEpisodes(14, limit * 2)
    .filter((row) => isRawScope(row.scope, policy))
    .slice(0, limit)
}

/** 注册话题记忆工具：remember / recall / inventory / demote。 */
export function registerTopicTools(ctx: Context, store: MemoryStore): void {
  ctx.tools.register('remember', async (args) => {
    const a = (args ?? {}) as { content?: string; topic?: string }
    const scope = writeScope()
    const id = await store.remember({
      content: String(a.content ?? ''),
      topic: a.topic ? String(a.topic) : undefined,
      scope,
    })
    const row = await store.getTopic(id)
    store.markDirty()
    return {
      content: JSON.stringify({
        topic: row?.canonicalName ?? '',
        state: row?.stateSummary ?? '',
        merged: (row?.nTimes ?? 0) > 1,
      }),
    }
  }, {
    description:
      '记一条值得长期记住的信息（用户明确要求记住、或你认为管线可能漏掉的重要事实）。加强已有话题或新建。' +
      'QQ 群回合只写入本群作用域，不会污染主人私聊或其他群的记忆。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记住的内容（一句话）' },
        topic: { type: 'string', description: '话题标签；留空则自动归类' },
      },
      required: ['content'],
    },
  })

  ctx.tools.register('recall', async (args) => {
    const a = (args ?? {}) as { query?: string; limit?: number }
    const query = String(a.query ?? '')
    const limit = Math.max(1, Math.min(Math.floor(Number(a.limit)) || 5, 20))
    const policy = recallPolicy()
    const external = policy.mode === 'group' || policy.mode === 'private'
    store.decayAll()

    // 群回合扩大候选池：owner/private 已被 Rust 过滤，剩余按作用域分原文/模糊。
    const candidates = await store.blockingCandidates(
      query,
      external ? Math.min(Math.max(limit * 8, 40), 400) : limit * 2,
      scopeFilter(policy),
    )
    const now = Date.now()
    const raw = candidates
      .filter((row) => isRawScope(row.scope, policy))
      .map((row) => ({ row, score: scoreTopic(row, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ row, score }) => toResult(row, score))
    const fuzzy = policy.mode === 'group'
      ? candidates
          .filter((row) => isOtherGroupScope(row.scope, policy))
          .sort((a, b) => b.lastDiscussedAt - a.lastDiscussedAt)
          .slice(0, Math.max(0, limit - raw.length))
          .map(toFuzzyResult)
      : []
    const results: Array<Record<string, unknown>> = [...raw, ...fuzzy]

    // 实体图谱只对本地/主人私聊开放：QQ 外部回合不返回属性与关系细节。
    let entities: Array<{
      name: string
      type: string | null
      attrs: Record<string, string>
      related: Array<{ to: string; relation: string }>
    }> = []
    if (allowsEntities(policy)) {
      try {
        const graphs = await store.entityCandidates(query, Math.max(3, limit))
        entities = graphs.map((g) => ({
          name: g.entity.name,
          type: g.entity.entityType ?? null,
          attrs: Object.fromEntries(g.attrs.map((x) => [x.attrKey, x.attrValue])),
          related: g.neighbors.map((n) => ({
            to: n.entity.name,
            relation: n.direction === 'out' ? n.relation : `←${n.relation}`,
          })),
        }))
      } catch (err) {
        console.warn(`[memory] 实体召回失败: ${(err as Error)?.message ?? err}`)
      }
    }

    // 无词法命中 → Mode B 兜底：最近经历（群回合可再补其他群轮廓）
    if (results.length === 0 && entities.length === 0) {
      const recent = rawRecent(store, policy, limit)
      results.push(...recent.map((row) => toResult(row, 0.5)))
      if (results.length === 0 && policy.mode === 'group') {
        const other = store.recentEpisodes(14, limit * 2)
          .filter((row) => isOtherGroupScope(row.scope, policy))
          .slice(0, limit)
        results.push(...other.map(toFuzzyResult))
      }
    }
    return { content: JSON.stringify({ results, entities }) }
  }, {
    description:
      '检索长期记忆（话题事实 + 实体图谱：人/物/属性/关系）。返回结构化结果；无相关记忆时如实说不知道，不要编造。' +
      'QQ 群回合：本群与公共记忆给原文，其他群只给模糊轮廓；不返回实体属性/关系。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索内容，如"吉他"、"小明是谁"、"他工作上的事"' },
        limit: { type: 'number', description: '返回条数，默认 5' },
      },
      required: ['query'],
    },
  })

  ctx.tools.register('inventory', async (args) => {
    const a = args as { query?: string; limit?: number }
    store.decayAll()
    const query = a.query ? String(a.query) : ''
    const limit = Number(a.limit) || 10
    let rows = await store.listTopics()
    if (query) {
      const ids = new Set((await store.blockingCandidates(query, 20)).map((c) => c.id))
      rows = rows.filter((r) => ids.has(r.id))
    }
    rows.sort((a, b) => b.lastDiscussedAt - a.lastDiscussedAt)
    let entities: Array<{ name: string; type: string | null; attrs: Record<string, string> }> = []
    try {
      const graphs = query
        ? await store.entityCandidates(query, limit)
        : (await store.listEntities(limit)).map((e) => ({ entity: e, attrs: [], neighbors: [] }))
      entities = (graphs as Array<{ entity: { name: string; entityType?: string | null }; attrs: Array<{ attrKey: string; attrValue: string }> }>)
        .map((g) => ({
          name: g.entity.name,
          type: g.entity.entityType ?? null,
          attrs: Object.fromEntries(g.attrs.map((x) => [x.attrKey, x.attrValue])),
        }))
    } catch (err) {
      console.warn(`[memory] 实体盘点失败: ${(err as Error)?.message ?? err}`)
    }
    return {
      content: JSON.stringify({
        total: rows.length,
        topics: rows.slice(0, limit).map((r) => ({
          topic: r.canonicalName, state: r.stateSummary,
          when: humanWhen(r.lastDiscussedAt), nTimes: r.nTimes,
        })),
        entities,
        profile: (store.getCard().profile ?? '').slice(0, 500),
      }),
    }
  }, {
    description: '盘点长期记忆：我关于某个话题（或整体）知道什么、哪块是空白。用于决定要不要主动追问。含话题与实体图谱。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '限定话题；留空盘点全部' },
        limit: { type: 'number', description: '返回条数，默认 10' },
      },
    },
  })

  ctx.tools.register('demote', async (args) => {
    const a = args as { query?: string; reason?: string }
    const query = String(a.query ?? '')
    store.decayAll()
    const candidates = await store.blockingCandidates(query, 5)
    if (candidates.length === 0) return { content: JSON.stringify({ demoted: false, topic: query }) }
    const ok = await store.demote(candidates[0].id, a.reason ? String(a.reason) : undefined)
    store.markDirty()
    return { content: JSON.stringify({ demoted: ok, topic: candidates[0].canonicalName }) }
  }, {
    description: '把一条记忆标记为不重要（减弱权重，会随时间衰减淡出；用户重新提起即复活，可逆）。不要删除记忆。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要淡出的话题，如"吉他计划"' },
        reason: { type: 'string', description: '原因（可选）' },
      },
      required: ['query'],
    },
  })
}
