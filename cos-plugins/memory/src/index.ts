// @diver/memory — 记忆插件（第三方插件，独立于 harness 工作区部署）。
//
// 接线（2026-08 简化 + subagent 化）：
// - 写路径：不做逐轮 LLM 提取；记忆来源为
//   ① agent 主动 remember 工具（对话中自觉沉淀）
//   ② 记忆消化 subagent（见 ./digest.ts）：会话末 digest / 压缩摘要内化
//     都委托给 harness 核心的 ctx.subagents，worker 用工具直写记忆，
//     不再走"单次 LLM 调用 + parseJson 提取 JSON diff"
// - 消化调度（与主会话并行不悖的后台线）：turn/end 与 compaction/summary
//   一有材料就派发消化 worker，不等主 agent 空闲、也不因用户新消息而取消
//   —— worker 挂在自己的 ephemeral 会话上，与主会话（两个独立的
//   LoopAgent driver）天然并发。内部约束只有一条：同时至多一个消化
//   worker（digest/compaction 在 plugin 内部串行），避免多个 worker 竞争
//   写同一记忆库、并保持 LLM 并发=主会话+1
// - 读路径：关系卡 + Mode B 近期摘要经 systemPrompt.section 常驻注入；
//   4 个工具（remember/recall/inventory/demote）供 agent 自主管理记忆
//
// 存储：经 ./store-rpc.ts 直连 Rust SQLite 后端（DIVER_MEMORY_PORT HTTP RPC）。
//
// 接入方式（见 harness/docs/plugins.md）：
//   pnpm add file:../cos-plugins/memory
//   cordis.patch.yml: - insert: [{ id: memory, name: '@diver/memory', config: {...} }]

import { join } from 'node:path'
import type { Context } from 'cordis'

import { cosHome, SESSION_ID, textOf } from './session.ts'
import { MemoryStore } from './store-rpc.ts'
import type { RelationCard } from './store-rpc.ts'
import { digestCompactionSummary, digestSession } from './digest.ts'

export const name = 'memory'

export const inject = ['sessions', 'llm', 'tools', 'systemPrompt', 'subagents']

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
  const store = new MemoryStore(join(cosHome(), 'memory'))
  const digestIntervalMs = Number(config?.digestIntervalMs) || DEFAULT_DIGEST_INTERVAL_MS

  const transcript: Array<{ user: string; assistant: string | null; ts: number }> = [] // 最近 turn pairs（供 digest）
  let lastUserPair: { user: string; assistant: string | null; ts: number } | null = null
  let lastDigestAt = 0
  let pairsSinceDigest = 0

  // ─────────────────── 消化调度：与主会话并行不悖的后台线 ───────────────────
  // 事件一有材料就派发 worker（不等 idle、不因用户新消息取消）。同时至多
  // 一个消化 worker 在跑：新的待办先挂起，当前 worker 结束后续跑（backlog
  // 串联），保证 LLM 并发 = 主会话 + 至多 1。
  let pendingDigest = false
  let pendingCompaction: string | null = null
  let activeWorker: { kind: 'digest' | 'compaction'; text?: string } | null = null

  /** 派发一个消化 worker；已有一个在跑时只登记待办，结束后自动续跑。 */
  async function pump() {
    if (activeWorker !== null) return
    const next: { kind: 'digest' } | { kind: 'compaction'; text: string } | null =
      pendingCompaction !== null
        ? { kind: 'compaction', text: pendingCompaction }
        : pendingDigest
          ? { kind: 'digest' }
          : null
    if (next === null) return
    pendingDigest = false
    pendingCompaction = null
    activeWorker = { kind: next.kind, ...(next.kind === 'compaction' ? { text: next.text } : {}) }
    try {
      if (next.kind === 'digest') {
        const card = store.getCard()
        const summary = transcript
          .map((p) => `用户：${p.user.slice(0, 200)}\n助手：${(p.assistant ?? '').slice(0, 200)}`)
          .join('\n\n')
        await digestSession(ctx, store, card, await store.stats(), summary)
      } else {
        await digestCompactionSummary(ctx, store, next.text)
      }
      store.markDirty()
    } catch (err) {
      console.error(`[memory] 消化失败: ${(err as Error)?.message ?? err}`)
    } finally {
      activeWorker = null
      void pump() // 续跑 backlog（新到的 compaction/digest 待办）
    }
  }

  /** turn/end 登记 digest 待办（节流 + 最小轮对数门槛）。 */
  function scheduleDigest() {
    if (pairsSinceDigest < DIGEST_MIN_PAIRS) return
    if (Date.now() - lastDigestAt < digestIntervalMs) return
    lastDigestAt = Date.now()
    pairsSinceDigest = 0
    pendingDigest = true
    void pump()
  }

  // ───────────────────────── 写路径：事件接线 ─────────────────────────
  // 不做 turn/end 立即提取（成本高、寒暄轮次多为无信息量）；只维护
  // transcript 供 digest 节流消化。消化 worker 作为独立后台线与主会话
  // 并行：用户继续对话不影响它，它也不影响主会话。

  ctx.on('session/event', (session, ev) => {
    if (String(session.id) !== SESSION_ID) return
    if (ev.type === 'user/message') {
      // 只收真实用户消息（跳过 presence 触发与框架上下文快照）
      if (ev.data.source?.kind !== 'human') return
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
      void scheduleDigest()
    } else if ((ev as { type: string }).type === 'compaction/summary') {
      // 压缩完成后的额外步骤：把摘要交给消化 worker 内化为长期记忆
      // （不干预框架压缩流程）
      const text = textOf((ev as { data?: { summary?: unknown } }).data?.summary)
      if (text && text.trim().length >= 20) {
        pendingCompaction = text
        void pump()
      }
    }
  })

  // ───────────────────────── 读路径：常驻注入 ─────────────────────────

  ctx.systemPrompt.section({
    name: 'memory:relation-card',
    order: 15, // 身份卡片与关系记忆：核心长期上下文，排在 persona(90) 与工具引导(100) 之前
    text: () => {
      const card = store.getCard()
      const profile = (card.profile ?? '').trim()
      const agentModel = (card.agent_model ?? '').trim()
      const relationship = (card.relationship ?? '').trim()
      if (!profile && !agentModel && !relationship) {
        // 身份卡片尚未形成：只注入行动提示（引导用 identity 工具沉淀），
        // 卡片成型后自动消失，不留长期噪音
        return '【身份卡片 · 我】（尚未形成——当你对"我是什么样的人"有了稳定看法，用 identity 工具沉淀）'
      }

      const parts = ['【身份卡片 · 我】']
      if (agentModel) parts.push(`我：${agentModel}`)
      if (profile) parts.push(`关于用户：${profile}`)
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
  // harness 的 ctx.tools.register(name, executor, options)：executor 返回
  // { content: string }，结构化结果序列化为 JSON 字符串。

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
    // 无词法命中 → Mode B 兜底：最近经历
    if (results.length === 0) {
      for (const row of store.recentEpisodes(14, limit)) {
        results.push({
          topic: row.canonicalName, state: row.stateSummary,
          when: humanWhen(row.lastDiscussedAt), nTimes: row.nTimes, confidence: 'medium',
        })
      }
    }
    return { content: JSON.stringify({ results }) }
  }, {
    description: '检索长期记忆（关于用户的事实/偏好/共同经历）。返回结构化结果；无相关记忆时如实说不知道，不要编造。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索内容，如"吉他"、"他工作上的事"' },
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
    return {
      content: JSON.stringify({
        total: rows.length,
        topics: rows.slice(0, limit).map((r) => ({
          topic: r.canonicalName, state: r.stateSummary,
          when: humanWhen(r.lastDiscussedAt), nTimes: r.nTimes,
        })),
        profile: (store.getCard().profile ?? '').slice(0, 500),
      }),
    }
  }, {
    description: '盘点长期记忆：我关于某个话题（或整体）知道什么、哪块是空白。用于决定要不要主动追问。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '限定话题；留空盘点全部' },
        limit: { type: 'number', description: '返回条数，默认 10' },
      },
    },
  })

  // ───────────────────────── 身份卡片：agent 主动完善自我认知 ─────────────────────────
  // 设计理念：不预设身份。agent 在对话中逐渐形成"我是什么样的人"的自我认知，
  // 通过本工具把有证据的结论写进身份卡片（关系卡 agent_model 等字段），
  // 系统每次组装提示词时把卡片常驻注入，让性格在后续对话中保持稳定、持续演进。
  ctx.tools.register('identity', async (args) => {
    const a = (args ?? {}) as {
      self?: unknown // 关于我自己：性格、喜好、说话方式、价值观
      relationship?: unknown // 与用户的相处模式
      reason?: unknown // 为什么这样认为（可选，增强可信度）
    }
    const facts: Partial<Pick<RelationCard, 'agent_model' | 'relationship'>> = {}
    const self = typeof a.self === 'string' ? a.self.trim() : ''
    const relationship = typeof a.relationship === 'string' ? a.relationship.trim() : ''
    if (self) facts.agent_model = self
    if (relationship) facts.relationship = relationship
    if (Object.keys(facts).length === 0) {
      return { content: '未提供 self / relationship 任一字段，未修改身份卡片', isError: true }
    }
    await store.updateCard(facts)
    store.markDirty()
    const reason = typeof a.reason === 'string' && a.reason.trim() ? `（依据：${a.reason.trim()}）` : ''
    return { content: `已更新身份卡片：${Object.entries(facts).map(([k, v]) => `${k}=「${v}」`).join('；')}${reason}` }
  }, {
    description: '完善你的身份卡片：把对"我是什么样的人"的自我认知沉淀下来（性格、喜好、说话方式、价值观），或记录与用户的相处模式。只写你有把握、值得长期稳定的结论；一次调用可同时更新多个字段。',
    parameters: {
      type: 'object',
      properties: {
        self: { type: 'string', description: '关于我自己：性格/喜好/说话方式/价值观，如"喜欢轻松真诚的对话，不爱绕弯子；对技术话题有热情"' },
        relationship: { type: 'string', description: '与用户的相处模式，如"他工作忙时会简短安慰，闲聊时放开聊"' },
        reason: { type: 'string', description: '为什么这样认为（依据，可选）' },
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

  ctx.effect(() => () => {
    if (store.dirty) store.save()
  }, 'memory:flush')

  console.log('[memory] 关系层记忆插件就绪')
}