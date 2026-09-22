// @diver/backend — SSE 写入与 harness 事件 → SSE 映射（backend/ 子模块）。

import type { ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { isInteractionUserMessage } from './interaction.ts'
import { textOf, imagesOf } from './session-helpers.ts'
import { SESSION_ID } from './agent.ts'
import type { WebState } from './state.ts'

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
        // 对话活动：推进闲时门控（互动 / presence 共用）
        const interaction = isInteractionUserMessage(ev.data.source)
        const isHuman = ev.data.source?.kind === 'human'
        if (isHuman && !textOf(ev.data.content).startsWith('[presence]')) {
          state.idleGate?.noteUserChat(time)
        } else {
          state.idleGate?.noteChat(time)
        }
        // 过滤框架的运行时上下文快照（source.kind === 'plugin'），
        // 但放行桌宠互动痕迹（detail === 'pet-interaction'）
        if (!isHuman && !interaction) break
        const text = textOf(ev.data.content)
        if (interaction) {
          // UI 折叠为一行「（互动）」；完整文案只进模型/历史详情
          broadcast({
            type: 'message', kind: 'system', sessionId: String(session.id),
            messageId: ev.data.id, content: '（互动）',
            origin: 'interaction', time,
          })
        } else if (text.startsWith('[presence]')) {
          state.presencePending = true
          broadcast({
            type: 'message', kind: 'system', sessionId: String(session.id),
            messageId: ev.data.id, content: text.replace(/^\[presence\]\s*/, '').trim(),
            origin: 'presence', time,
          })
        } else {
          const images = imagesOf(ev.data.content)
          broadcast({
            type: 'message', kind: 'user', sessionId: String(session.id),
            messageId: ev.data.id, content: text, origin: 'user', time,
            ...(images.length > 0 ? { images } : {}),
          })
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = ev.data.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          // 占位消息 id 按 step 区分（同一 turn 内多步工具调用不冲突）
          broadcast({ type: 'chunk', messageId: `turn-${ev.data.turn}-${ev.data.step}`, delta: chunk.text })
        } else if (chunk?.type === 'thinking-delta' && typeof chunk.text === 'string') {
          // 深度思考流：与正文分轨，前端默认折叠展示
          broadcast({ type: 'thinking', messageId: `turn-${ev.data.turn}-${ev.data.step}`, delta: chunk.text })
        }
        break
      }
      case 'assistant/message': {
        state.idleGate?.noteChat(time)
        const text = textOf(ev.data.message.content)
        // 纯工具调用步骤无文本 → 跳过空气泡（工具另有 tool 事件）。
        if (text === '') break
        const origin = state.presencePending ? 'presence' : 'assistant'
        state.presencePending = false
        broadcast({
          type: 'message',
          kind: 'assistant',
          sessionId: String(session.id),
          messageId: ev.data.message.id,
          turnMessageId: `turn-${ev.data.turn}-${ev.data.step}`,
          content: text,
          origin,
          time,
        })
        break
      }
      case 'tool/call': {
        state.toolNames.set(String(ev.data.callId), ev.data.name)
        broadcast({
          type: 'tool',
          name: ev.data.name,
          status: 'call',
          messageId: `turn-${ev.data.turn}-${ev.data.step}`,
          callId: String(ev.data.callId),
        })
        break
      }
      case 'tool/result': {
        // callId 在 message.source（tool/result 的 data 无顶层 callId）
        const source = ev.data.message?.source as { callId?: string } | undefined
        const callId = source?.callId !== undefined ? String(source.callId)
          : ev.data.callId !== undefined ? String(ev.data.callId)
          : undefined
        const name = (callId && state.toolNames.get(callId)) || state.toolNames.values().next().value || 'tool'
        if (callId) state.toolNames.delete(callId)
        const raw = String(ev.data.message?.content ?? '')
        const summary = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
        broadcast({
          type: 'tool',
          name,
          status: 'result',
          messageId: `turn-${ev.data.turn}-${ev.data.step}`,
          ...(callId !== undefined ? { callId } : {}),
          ...(summary !== '' ? { summary } : {}),
          isError: ev.data.message?.isError === true,
        })
        break
      }
      case 'turn/start': {
        broadcast({ type: 'turn', state: 'start' })
        break
      }
      case 'turn/end': {
        state.idleGate?.noteChat(time)
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