// @diver/backend — SSE 写入与 harness 事件 → SSE 映射（backend/ 子模块）。

import type { ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { textOf } from './session-helpers'
import { SESSION_ID } from './session'
import type { WebState } from './types'

export function sseWrite(res: ServerResponse, event: unknown) {
  if (res.writableEnded || res.destroyed) return
  res.write(`event: event\ndata: ${JSON.stringify(event)}\n\n`)
}

export function createBroadcast(state: WebState) {
  return (event: unknown) => {
    for (const client of [...state.clients]) sseWrite(client, event)
  }
}

/** 订阅 harness 会话/agent 事件并转发为前端 SSE 事件。 */
export function attachEventListeners(
  ctx: Context,
  state: WebState,
  broadcast: (event: unknown) => void,
) {
  ctx.on('session/event', (session: any, ev: any) => {
    if (String(session.id) !== SESSION_ID) return
    const time = Number(ev.time) || Date.now()
    switch (ev.type) {
      case 'user/message': {
        // 过滤框架的运行时上下文快照（source.kind === 'plugin'），只透传真实用户消息
        if (ev.data.source?.kind !== 'human') break
        const text = textOf(ev.data.content)
        if (text.startsWith('[presence]')) {
          state.presencePending = true
          broadcast({
            type: 'message', kind: 'system', sessionId: String(session.id),
            messageId: ev.data.id, content: text.replace(/^\[presence\]\s*/, '').trim(),
            origin: 'presence', time,
          })
        } else {
          broadcast({
            type: 'message', kind: 'user', sessionId: String(session.id),
            messageId: ev.data.id, content: text, origin: 'user', time,
          })
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = ev.data.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          // 占位消息 id 按 step 区分（同一 turn 内多步工具调用不冲突）
          broadcast({ type: 'chunk', messageId: `turn-${ev.data.turn}-${ev.data.step}`, delta: chunk.text })
        }
        break
      }
      case 'assistant/message': {
        const text = textOf(ev.data.message.content)
        const origin = state.presencePending ? 'presence' : 'assistant'
        state.presencePending = false
        broadcast({
          type: 'message', kind: 'assistant', sessionId: String(session.id),
          messageId: ev.data.message.id, turnMessageId: `turn-${ev.data.turn}-${ev.data.step}`,
          content: text, origin, time,
        })
        break
      }
      case 'tool/call': {
        state.toolNames.set(String(ev.data.callId), ev.data.name)
        broadcast({ type: 'tool', name: ev.data.name, status: 'call' })
        break
      }
      case 'tool/result': {
        // callId 在 message.source（tool/result 的 data 无顶层 callId）
        const source = ev.data.message?.source as { callId?: string } | undefined
        const callId = source?.callId !== undefined ? String(source.callId) : undefined
        const name = (callId && state.toolNames.get(callId)) || state.toolNames.values().next().value || 'tool'
        if (callId) state.toolNames.delete(callId)
        broadcast({ type: 'tool', name, status: 'result' })
        break
      }
      case 'turn/start': {
        broadcast({ type: 'turn', state: 'start' })
        break
      }
      case 'turn/end': {
        broadcast({ type: 'turn', state: 'end', reason: ev.data.reason?.kind })
        break
      }
      default:
        break
    }
  })

  ctx.on('agent/error', ({ agent, turn, step, error }: any) => {
    if (!agent || String(agent.id) !== SESSION_ID) return
    const message = String((error as { message?: unknown } | null)?.message ?? error)
    console.error(`[diver] agent 错误 (turn=${turn}, step=${step}): ${message}`)
    broadcast({ type: 'error', message })
  })

  ctx.on('agent/status', ({ agent, status }: any) => {
    if (!agent || String(agent.id) !== SESSION_ID) return
    state.busy = status === 'running'
    broadcast({ type: 'busy', value: state.busy })
  })
}