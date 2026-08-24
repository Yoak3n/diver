// Diver companion — 记忆插件：关系层记忆（借鉴设计文档 memory-plugin.md）。
//
// 接线（2026-08 简化）：
// - 写路径：不做逐轮 LLM 提取；记忆来源为
//   ① agent 主动 remember 工具（对话中自觉沉淀）
//   ② 压缩 subagent（见 ./extract.ts）：深读被压缩历史 → 摘要内化为长期记忆
//   ③ 会话末 digest（节流 10 分钟，把最近轮次归纳进关系卡）
// - 读路径：关系卡 + Mode B 近期摘要经 systemPrompt.section 常驻注入；
//   4 个工具（remember/recall/inventory/demote）供 agent 自主管理记忆

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { dshHome, SESSION_ID, textOf } from '../session.ts'
import { MemoryStore } from './store-rpc.ts'
import { digestSession } from './extract.ts'

export const name = 'diver-companion-memory'

export const inject = ['sessions', 'llm', 'tools', 'systemPrompt', 'agentDefaultModel']

const DEFAULT_DIGEST_INTERVAL_MS = 10 * 60 * 1000
const DIGEST_MIN_PAIRS = 3
const TRANSCRIPT_CAP = 10

function humanWhen(ts: number) {
  const now = Date.now()
  const diff = now - ts
  const day = 24 * 60 * 60 * 1000
  if (diff < day) return '今天'
  if (diff < 2 * day) return '昨天'
  if (diff < 7 * day) return `${Math.floor(diff / day)}天前`
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}周前`
  return `${Math.floor(diff / (30 * day))}个月前`
}

function timeHm(ts: number) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function apply(ctx: Context, config: { digestIntervalMs?: number }) {
  const store = new MemoryStore(join(dshHome(), 'memory'))
  const digestIntervalMs = Number(config?.digestIntervalMs) || DEFAULT_DIGEST_INTERVAL_MS

  const transcript = [] // 最近 turn pairs（供 digest，不再做逐轮 LLM 提取）
  let lastUserPair = null // 最近未配对的用户消息
  let lastDigestAt = 0
  let pairsSinceDigest = 0

  // ───────────────────────── 写路径：事件接线 ─────────────────────────
  // 不做 turn/end 立即提取（成本高、寒暄轮次多为无信息量）；只维护
  // transcript 供 digest 节流消化。

  ctx.on('session/event', (session, ev) => {
    if (String(session.id) !== SESSION_ID) return
    if (ev.type === 'user/message') {
      // 只收真实用户消息（跳过 presence 触发与框架上下文快照）
      if (ev.data.source?.kind !== 'user') return
      const text = textOf(ev.data.content)
      if (!text || text.startsWith('[presence]')) return
      lastUserPair = { user: text, assistant: null, ts: Number(ev.time) || Date.now() }
    } else if (ev.type === 'assistant/message') {
      const last = lastUserPair
      if (last && last.assistant === null) {
        last.assistant = textOf(ev.data.message.content)
      }
    } else if (ev.type === 'turn/end') {
      if (lastUserPair && lastUserPair.assistant !== null) {
        transcript.push(lastUserPair)
        if (transcript.length > TRANSCRIPT_CAP) transcript.shift()
        pairsSinceDigest += 1
        lastUserPair = null
      }
      void maybeDigest()
    } else if ((ev as { type: string }).type === 'compaction/summary') {
      // 压缩完成后的额外步骤：把摘要内化为长期记忆（不干预框架压缩流程）
      void ingestCompactionSummary(ev as { data?: { summary?: unknown } })
    }
  })

  // ── 压缩摘要内化：被压缩的上下文变成一段有丰富信息的记忆 ──────────────
  // base compaction-basic 默认引擎压缩完成后产生 compaction/summary 事件；
  // 这里把摘要原文作为「会话历史回顾」话题的事件持久化，可被 recall/
  // inventory 检索到，早期关键事实不因压缩而丢失。
  async function ingestCompactionSummary(ev) {
    const text = textOf(ev.data?.summary)
    if (!text || text.trim().length < 20) return
    try {
      const topicName = '会话历史回顾'
      let topicId = null
      store.decayAll()
      const cands = await store.blockingCandidates(topicName, 3)
      topicId = cands.find((c) => c.canonicalName.includes('历史回顾'))?.id ?? null
      if (!topicId) {
        topicId = await store.createTopic({
          canonicalName: topicName,
          stateSummary: '早期对话的压缩摘要合集（随上下文压缩产生）',
          tier: 'episodic',
          uncertain: true,
        })
      }
      await store.appendEvent({ topicId, statement: text, ts: Date.now() })
      store.markDirty()
      console.log(`[memory] 压缩摘要已内化（${text.length} 字符）`)
    } catch (err) {
      console.error(`[memory] 压缩摘要内化失败: ${err?.message ?? err}`)
    }
  }

  async function maybeDigest() {
    if (pairsSinceDigest < DIGEST_MIN_PAIRS) return
    if (Date.now() - lastDigestAt < digestIntervalMs) return
    lastDigestAt = Date.now()
    pairsSinceDigest = 0
    try {
      const card = store.getCard()
      const summary = transcript
        .map((p) => `用户：${p.user.slice(0, 200)}\n助手：${(p.assistant ?? '').slice(0, 200)}`)
        .join('\n\n')
      const diff = await digestSession(ctx, card, await store.stats(), summary)
      if (diff) {
        await store.updateCard(diff)
        store.markDirty()
        console.log('[memory] 会话消化完成')
      }
    } catch (err) {
      console.error(`[memory] 消化失败: ${err?.message ?? err}`)
    }
  }

  // ───────────────────────── 读路径：常驻注入 ─────────────────────────

  ctx.systemPrompt.section({
    name: 'memory:relation-card',
    order: 15, // persona(0) 之后、工具引导(100) 之前
    text: () => {
      const card = store.getCard()
      const profile = (card.profile ?? '').trim()
      const agentModel = (card.agent_model ?? '').trim()
      const relationship = (card.relationship ?? '').trim()
      if (!profile && !agentModel && !relationship) return ''

      const parts = ['【记忆 · 我们之间】']
      if (profile) parts.push(`关于用户：${profile}`)
      if (agentModel) parts.push(`关于我：${agentModel}`)
      if (relationship) parts.push(`我们之间：${relationship}`)

      // Mode B — 时间检索（最近经历 / 未完成承诺 / 今天事件）：主动性燃料
      const episodes = store.recentEpisodes(14, 3)
      if (episodes.length > 0) {
        parts.push('【近期共同经历】' + episodes.map((e) =>
          `- ${humanWhen(e.lastDiscussedAt)}聊过「${e.canonicalName}」（${e.nTimes}次）—— ${(e.stateSummary ?? '').slice(0, 100)}`,
        ).join('\n'))
      }
      const promises = store.listPromises('open').slice(-3)
      if (promises.length > 0) {
        parts.push('【未完成承诺】' + promises.map((p) => `- ${p.content.slice(0, 80)}`).join('\n'))
      }
      const today = store.todayEvents().slice(-3)
      if (today.length > 0) {
        parts.push('【今天】' + today.map((e) => `- ${timeHm(e.ts)} ${e.statement.slice(0, 60)}`).join('\n'))
      }
      return parts.join('\n\n')
    },
  })

  // ───────────────────────── 工具面：agent 自主管理 ─────────────────────────

  ctx.tools.register(defineTool({
    name: 'remember',
    description: '记一条值得长期记住的信息（用户明确要求记住、或你认为管线可能漏掉的重要事实）。加强已有话题或新建。',
    parameters: {
      content: { type: 'string', required: true, description: '要记住的内容（一句话）' },
      topic: { type: 'string', description: '话题标签；留空则自动归类' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: { type: 'string', required: true },
          state: { type: 'string', required: true },
          merged: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const id = await store.remember({ content: String(args.content), topic: args.topic ? String(args.topic) : undefined })
      const row = await store.getTopic(id)
      store.markDirty()
      return { topic: row.canonicalName, state: row.stateSummary, merged: row.nTimes > 1 }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'recall',
    description: '检索长期记忆（关于用户的事实/偏好/共同经历）。返回结构化结果；无相关记忆时如实说不知道，不要编造。',
    parameters: {
      query: { type: 'string', required: true, description: '检索内容，如"吉他"、"他工作上的事"' },
      limit: { type: 'number', description: '返回条数，默认 5' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                topic: { type: 'string', required: true },
                state: { type: 'string', required: true },
                when: { type: 'string', required: true },
                nTimes: { type: 'number', required: true },
                confidence: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const query = String(args.query ?? '')
      const limit = Number(args.limit) || 5
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
      }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, limit)

      const results = scored.map((r) => ({
        topic: r.topic, state: r.state, when: r.when, nTimes: r.nTimes,
        confidence: r.score > 0.7 ? 'high' : r.score > 0.4 ? 'medium' : 'low',
      }))
      // 无词法命中 → Mode B 兜底：最近经历
      if (results.length === 0) {
        for (const row of store.recentEpisodes(14, limit)) {
          results.push({
            topic: row.canonicalName, state: row.stateSummary,
            when: humanWhen(row.lastDiscussedAt), nTimes: row.nTimes, confidence: 'medium',
          })
        }
      }
      return { results }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'inventory',
    description: '盘点长期记忆：我关于某个话题（或整体）知道什么、哪块是空白。用于决定要不要主动追问。',
    parameters: {
      query: { type: 'string', description: '限定话题；留空盘点全部' },
      limit: { type: 'number', description: '返回条数，默认 10' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          topics: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                topic: { type: 'string', required: true },
                state: { type: 'string', required: true },
                when: { type: 'string', required: true },
                nTimes: { type: 'number', required: true },
              },
            },
          },
          profile: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      store.decayAll()
      const query = args.query ? String(args.query) : ''
      const limit = Number(args.limit) || 10
      let rows = await store.listTopics()
      if (query) {
        const ids = new Set((await store.blockingCandidates(query, 20)).map((c) => c.id))
        rows = rows.filter((r) => ids.has(r.id))
      }
      rows.sort((a, b) => b.lastDiscussedAt - a.lastDiscussedAt)
      return {
        total: rows.length,
        topics: rows.slice(0, limit).map((r) => ({
          topic: r.canonicalName, state: r.stateSummary,
          when: humanWhen(r.lastDiscussedAt), nTimes: r.nTimes,
        })),
        profile: (store.getCard().profile ?? '').slice(0, 500),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'demote',
    description: '把一条记忆标记为不重要（减弱权重，会随时间衰减淡出；用户重新提起即复活，可逆）。不要删除记忆。',
    parameters: {
      query: { type: 'string', required: true, description: '要淡出的话题，如"吉他计划"' },
      reason: { type: 'string', description: '原因（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          demoted: { type: 'boolean', required: true },
          topic: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const query = String(args.query ?? '')
      store.decayAll()
      const candidates = await store.blockingCandidates(query, 5)
      if (candidates.length === 0) return { demoted: false, topic: query }
      const ok = await store.demote(candidates[0].id, args.reason ? String(args.reason) : undefined)
      store.markDirty()
      return { demoted: ok, topic: candidates[0].canonicalName }
    },
  }))

  ctx.on('dispose', () => {
    if (store.dirty) store.save()
  })

  console.log('[memory] 关系层记忆插件就绪')
}
