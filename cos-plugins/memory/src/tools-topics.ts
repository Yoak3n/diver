// @diver/memory — 工具面（话题记忆）：remember / recall / inventory / demote。
// harness 的 ctx.tools.register(name, executor, options)：executor 返回
// { content: string }，结构化结果序列化为 JSON 字符串。

import type { Context } from 'cordis'
// Load Cordis Context service-key declarations (ctx.tools …).
import type {} from '@cos/plugin-api'

import type { MemoryStore } from './store-rpc.ts'
import { humanWhen } from './timefmt.ts'

/** 注册话题记忆工具：remember / recall / inventory / demote。 */
export function registerTopicTools(ctx: Context, store: MemoryStore): void {
  ctx.tools.register('remember', async (args) => {
    const a = args as { content?: string; topic?: string }
    const id = await store.remember({ content: String(a.content ?? ''), topic: a.topic ? String(a.topic) : undefined })
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
    description: '记一条值得长期记住的信息（用户明确要求记住、或你认为管线可能漏掉的重要事实）。加强已有话题或新建。',
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
    const a = args as { query?: string; limit?: number }
    const query = String(a.query ?? '')
    const limit = Number(a.limit) || 5
    store.decayAll()
    const candidates = await store.blockingCandidates(query, limit * 2)
    const now = Date.now()
    const scored = candidates.map((c) => {
      const row = c
      if (!row) return null
      const recency = Math.max(0, 1 - (now - row.lastDiscussedAt) / (30 * 24 * 60 * 60 * 1000))
      const activation = 1 + Math.min(row.activationCount, 10) * 0.1
      const score = row.weight * activation * (0.4 + 0.6 * recency)
      return {
        id: row.id, topic: row.canonicalName, state: row.stateSummary,
        when: humanWhen(row.lastDiscussedAt), nTimes: row.nTimes, score,
      }
    }).filter((r): r is NonNullable<typeof r> => Boolean(r)).sort((a, b) => b.score - a.score).slice(0, limit)

    const results = scored.map((r) => ({
      topic: r.topic, state: r.state, when: r.when, nTimes: r.nTimes,
      confidence: r.score > 0.7 ? 'high' : r.score > 0.4 ? 'medium' : 'low',
    }))

    // 实体图谱一跳展开：名字命中 → 属性 + 关系（多跳召回原料）
    let entities: Array<{
      name: string
      type: string | null
      attrs: Record<string, string>
      related: Array<{ to: string; relation: string }>
    }> = []
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

    // 无词法命中 → Mode B 兜底：最近经历
    if (results.length === 0 && entities.length === 0) {
      for (const row of store.recentEpisodes(14, limit)) {
        results.push({
          topic: row.canonicalName, state: row.stateSummary,
          when: humanWhen(row.lastDiscussedAt), nTimes: row.nTimes, confidence: 'medium',
        })
      }
    }
    return { content: JSON.stringify({ results, entities }) }
  }, {
    description: '检索长期记忆（话题事实 + 实体图谱：人/物/属性/关系）。返回结构化结果；无相关记忆时如实说不知道，不要编造。',
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
