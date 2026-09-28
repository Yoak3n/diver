// @diver/memory — 消化调度：与主会话并行不悖的后台线。
//
// 事件一有材料就派发 worker（不等 idle、不因用户新消息取消）。同时至多
// 一个消化 worker 在跑：新的待办先挂起，当前 worker 结束后续跑（backlog
// 串联），保证 LLM 并发 = 主会话 + 至多 1。
//
// 写路径不做 turn/end 立即提取（成本高、寒暄轮次多为无信息量）；只维护
// transcript 供 digest 节流消化。消化 worker 作为独立后台线与主会话
// 并行：用户继续对话不影响它，它也不影响主会话。

import type { Context } from 'cordis'
// Load Cordis Context service-key declarations (sessions / llm / subagents …).
import type {} from '@cos/plugin-api'

import { SESSION_ID, textOf } from './session.ts'
import type { MemoryStore } from './store-rpc.ts'
import { digestCompactionSummary, digestSession } from './digest.ts'

const DEFAULT_DIGEST_INTERVAL_MS = 10 * 60 * 1000
const DIGEST_MIN_PAIRS = 3
const TRANSCRIPT_CAP = 10

/** 挂载消化调度（turn/end 登记 digest 待办；compaction/summary 派发内化）。 */
export function startDigestScheduler(ctx: Context, store: MemoryStore, digestIntervalMs?: number): void {
  const intervalMs = Number(digestIntervalMs) || DEFAULT_DIGEST_INTERVAL_MS

  const transcript: Array<{ user: string; assistant: string | null; ts: number }> = [] // 最近 turn pairs（供 digest）
  let lastUserPair: { user: string; assistant: string | null; ts: number } | null = null
  let lastDigestAt = 0
  let pairsSinceDigest = 0

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
    if (Date.now() - lastDigestAt < intervalMs) return
    lastDigestAt = Date.now()
    pairsSinceDigest = 0
    pendingDigest = true
    void pump()
  }

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
}
