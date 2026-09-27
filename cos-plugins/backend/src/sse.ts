// @diver/backend — SSE 写入与 harness 事件 → SSE 映射（backend/ 子模块）。

import type { ServerResponse } from 'node:http'
import type { Context } from 'cordis'
import { nativeRpc } from '@diver/native-bridge/rpc'
import { groupNameFromMarker, groupTag, injectOrigin, injectUiLabel, isGroupMessage, peerSource, stripGroupMarker, stripPeerMarker } from './interaction.ts'
import { textOf, imagesOf } from './session-helpers.ts'
import { SESSION_ID } from './agent.ts'
import type { WebState } from './state.ts'

/** 向壳 CompanionPresence 回压（失败只打日志，不影响 SSE）。 */
function reportPresence(method: string, params: Record<string, unknown>) {
  void nativeRpc(method, params, { label: method }).catch((err) => {
    console.warn(`[presence] 回压 ${method} 失败:`, (err as Error)?.message ?? err)
  })
}

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
        // 对话活动：回压壳 L0/L2（门控真源在壳）
        const isHuman = ev.data.source?.kind === 'human'
        if (isHuman && !textOf(ev.data.content).startsWith('[presence]')) {
          reportPresence('presence::event', { type: 'USER_CHAT' })
          // busy(true) 经 wakeDriver 同步发出，恒先于本事件到达壳；FSM 此刻仍在
          // Ambient，(Ambient, Busy(true)) 无迁移会被吃掉，整轮卡 Listening。
          // USER_CHAT 落 Listening 后重发一次，T07 才能进 Thinking。
          if (state.busy) reportPresence('presence::busy', { busy: true })
        } else {
          reportPresence('presence::event', { type: 'CHAT_ACTIVITY' })
        }
        // 过滤框架的运行时上下文快照（source.kind === 'plugin'），
        // 但放行桌宠互动 / 壳端已裁决注入（detail 映射 UI 折叠）
        const injectLabel = injectUiLabel(ev.data.source)
        const injectFrom = injectOrigin(ev.data.source)
        if (!isHuman && injectLabel === null) break
        const text = textOf(ev.data.content)
        const peer = peerSource(ev.data.source)
        if (peer !== null) {
          // P2-3/P2-4 来源标记渲染：正文保留（剥壳盖章首行），from 结构化给 UI 徽标；
          // 群发言（kind group）进群合并流并挂回复归属，实例间私聊不进。
          // 注意：agent 自己的口头回复不打 group 标——没经 send_to_group 投递的
          // 话对方实例收不到，标进群流会显得「说了但没人听见」。
          const isGroup = peer.kind === 'group'
          const gid = peer.group ?? 'general'
          const gname = groupNameFromMarker(text) ?? undefined
          broadcast({
            type: 'message', kind: 'user', sessionId: String(session.id),
            messageId: ev.data.id, content: stripPeerMarker(text), origin: 'peer', from: peer.id, time,
            ...(isGroup ? { group: true, groupId: gid, ...(gname ? { groupName: gname } : {}) } : {}),
          })
          break
        }
        if (injectLabel !== null) {
          // presence 展示问候正文；互动/主动折叠为一行
          const isPresence = injectFrom === 'presence'
          const content = isPresence
            ? text.replace(/^\[presence\]\s*/, '').trim() || injectLabel
            : injectLabel
          broadcast({
            type: 'message', kind: 'system', sessionId: String(session.id),
            messageId: ev.data.id, content,
            origin: injectFrom ?? 'proactive', time,
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
          // 群聊广播：剥「在场提示」首行，group 归属（gid 从 source.detail 取）。
          const group = isGroupMessage(text)
          const gid = group ? (groupTag(ev.data.source) ?? 'general') : null
          const gname = group ? (groupNameFromMarker(text) ?? undefined) : undefined
          broadcast({
            type: 'message', kind: 'user', sessionId: String(session.id),
            messageId: ev.data.id, content: group ? stripGroupMarker(text) : text, origin: 'user', time,
            ...(group && gid !== null
              ? { group: true, groupId: gid, ...(gname ? { groupName: gname } : {}) }
              : {}),
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
        reportPresence('presence::event', { type: 'CHAT_ACTIVITY' })
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
        // 展开详情用：放宽截断（UI 折叠预览另做 80 字）；过长工具输出仍限幅防 SSE 膨胀
        const summary = raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw
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
        reportPresence('presence::event', { type: 'CHAT_ACTIVITY' })
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
    // busy 回压壳 L0（companion-presence-fsm.md §9）
    reportPresence('presence::busy', { busy: state.busy })
  })
}