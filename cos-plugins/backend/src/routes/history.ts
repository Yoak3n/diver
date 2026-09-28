// @diver/backend — 会话历史视图：/api/history 把持久化事件流重建为 UI 消息
// 视图模型（重启后恢复界面）。事件→消息的合并/归属规则是纯函数，单测友好。
// 群发言落账不在会话日志里（产品自有存储，见 ../group-sent.ts），重建后按时间并入。

import { SessionId } from '@cos/plugin-api'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { SESSION_ID } from '../agent.ts'
import { groupSentPath, mergeGroupSent, readGroupSent } from '../group-sent.ts'
import { sendJson } from '../http.ts'
import { textOf, imagesOf } from '../session-helpers.ts'
import {
  groupNameFromMarker,
  groupTag,
  injectOrigin,
  injectUiLabel,
  isGroupMessage,
  peerSource,
  stripEventStamp,
  stripGroupMarker,
  stripPeerMarker,
} from '../interaction.ts'
import type { WebHandlerDeps } from '../types.ts'
import { chunkBefore, parseHistoryQuery, roundTail } from './history-page.ts'

/**
 * @cos/persistence `prepare()` 回放事件中历史视图读取的最小结构面。
 * 真实 SessionEvent 是判别联合；这里合并成单一窄面（字段全可选），
 * 让重建逻辑不依赖 harness 类型即可单测。联合成员保证字段齐全时
 * 行为与窄面读取一致；`message` 用 `?.` 防御异常持久化行。
 */
export interface ReplayEvent {
  type: string
  time?: unknown
  data: {
    turn?: number
    step?: number
    chunk?: { type?: string; text?: unknown }
    id?: unknown
    content?: unknown
    /** user/message 的来源盖章（human / inject / peer / group）。 */
    source?: { kind?: string; detail?: string } | null
    callId?: unknown
    message?: {
      id?: unknown
      content?: unknown
      isError?: boolean
    }
  }
}

/**
 * 事件流 → UI 消息视图模型（纯函数）。
 * thinking-delta 挂回同 step 的 assistant 消息；tool/result 按 callId 回填
 * 工具结果。群合并流只收真正投递过的流量（群发言注入 / 用户广播）——
 * agent 未走 send_to_group 的口头回复不打 group 标（对方实例收不到，不能进群视图）。
 */
export function buildHistoryMessages(
  events: readonly ReplayEvent[],
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  // 逐步收集 thinking-delta，挂到同 step 的 assistant 消息上
  const thinkingByStep = new Map<string, string>()
  // step → 消息下标，便于 tool/result 回填工具结果
  const msgIndexByStep = new Map<string, number>()
  let presencePending = false
  for (const ev of events) {
    if (ev.type === 'assistant/chunk') {
      const chunk = ev.data.chunk
      if (chunk?.type === 'thinking-delta' && typeof chunk.text === 'string') {
        const stepKey = `turn-${ev.data.turn}-${ev.data.step}`
        thinkingByStep.set(stepKey, (thinkingByStep.get(stepKey) ?? '') + chunk.text)
      }
      continue
    }
    if (ev.type === 'tool/result') {
      const stepKey = `turn-${ev.data.turn}-${ev.data.step}`
      const idx = msgIndexByStep.get(stepKey)
      if (idx === undefined) continue
      const msg = messages[idx] as { tools?: Array<Record<string, unknown>> }
      const list = msg.tools ? [...msg.tools] : []
      // 与 SSE 对齐：callId 可能在 data.callId / message.callId / message.source.callId
      const msgAny = ev.data.message as { callId?: string; source?: { callId?: string } } | undefined
      const source = msgAny?.source
      const callId = source?.callId !== undefined ? String(source.callId)
        : ev.data.callId !== undefined ? String(ev.data.callId)
        : (msgAny?.callId !== undefined ? String(msgAny.callId) : undefined)
      const raw = String(ev.data.message?.content ?? '')
      // 与 SSE 对齐：详情可展开，过长仍限幅
      const summary = raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw
      const isError = ev.data.message?.isError === true
      let hit = list.findIndex((t) => callId !== undefined && t.callId === callId)
      if (hit < 0) {
        // 无 callId 命中时按名称合并到最近未完成的 call
        const name = (callId && list.find((t) => t.callId === callId)?.name) || 'tool'
        const i = [...list].reverse().findIndex((t) => t.name === name && t.status === 'call')
        hit = i >= 0 ? list.length - 1 - i : -1
      }
      if (hit >= 0) {
        list[hit] = {
          ...list[hit],
          status: 'result',
          ...(summary !== '' ? { summary } : {}),
          isError,
        }
      } else if (!(callId !== undefined && list.some((t) => t.callId === callId && t.status === 'result'))) {
        const name = (callId && list.find((t) => t.callId === callId)?.name) || 'tool'
        list.push({
          name,
          status: 'result',
          time: Number(ev.time) || Date.now(),
          ...(callId !== undefined ? { callId } : {}),
          ...(summary !== '' ? { summary } : {}),
          isError,
        })
      }
      messages[idx] = { ...msg, tools: list }
      continue
    }
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
    const time = Number(ev.time) || Date.now()
    if (ev.type === 'user/message') {
      const text = textOf(ev.data.content)
      // P2-3 来源标记渲染：peer 消息正文保留（剥壳盖章首行），from 结构化给 UI 徽标。
      const peer = peerSource(ev.data.source)
        if (peer !== null) {
          const isGroup = peer.kind === 'group'
          const gid = peer.group ?? 'general'
          const gname = groupNameFromMarker(text) ?? undefined
          messages.push({
            id: ev.data.id, kind: 'user',
            content: stripPeerMarker(text),
            origin: 'peer', from: peer.id, time,
            // 群发言才进群合并流；实例间私聊留在各自私聊视图。
            ...(isGroup ? { group: true, groupId: gid, ...(gname ? { groupName: gname } : {}) } : {}),
          })
          continue
        }
      // 过滤运行时上下文快照；放行真人消息与已裁决注入
      const injectLabel = injectUiLabel(ev.data.source)
      const injectFrom = injectOrigin(ev.data.source)
      if (ev.data.source?.kind !== 'human' && injectLabel === null) continue
      if (injectLabel !== null) {
        const isPresence = injectFrom === 'presence'
        // 剥事件时间戳 + [presence] 章：气泡自带时间，正文只留问候语。
        const content = isPresence
          ? stripEventStamp(text).replace(/^\[presence\]\s*/, '').trim() || injectLabel
          : injectLabel
        messages.push({
          id: ev.data.id, kind: 'system',
          content,
          origin: injectFrom ?? 'proactive', time,
        })
      } else if (text.startsWith('[presence]')) {
        presencePending = true
        messages.push({
          id: ev.data.id, kind: 'system',
          content: text.replace(/^\[presence\]\s*/, '').trim(),
          origin: 'presence', time,
        })
      } else {
        // 群聊广播：剥「在场提示」首行，group 归属（gid 从 source.detail 取）。
        const group = isGroupMessage(text)
        const gid = group ? (groupTag(ev.data.source) ?? 'general') : null
        const gname = group ? (groupNameFromMarker(text) ?? undefined) : undefined
        messages.push({
          id: ev.data.id,
          kind: 'user',
          content: group ? stripGroupMarker(text) : text,
          origin: 'user',
          ...(group && gid !== null
            ? { group: true, groupId: gid, ...(gname ? { groupName: gname } : {}) }
            : {}),
          time,
          ...(imagesOf(ev.data.content).length > 0 ? { images: imagesOf(ev.data.content) } : {}),
        })
      }
    } else if (ev.type === 'assistant/message') {
      const text = textOf(ev.data.message?.content)
      const stepKey = `turn-${ev.data.turn}-${ev.data.step}`
      const thinking = thinkingByStep.get(stepKey) ?? ''
      // assistant 消息中的 tool-call 块 → 工具记录（结果由后续 tool/result 回填）
      const blocks = Array.isArray(ev.data.message?.content) ? ev.data.message?.content : []
      const tools = (blocks as any[])
        .filter((b: any) => b && (b.type === 'tool-call' || b.type === 'toolCall'))
        .map((b: any) => ({
          name: String(b.name ?? 'tool'),
          status: 'call',
          time,
          ...(b.id !== undefined ? { callId: String(b.id) } : {}),
        }))
      // 无文本、无思考、无工具的步骤不进历史，避免空气泡
      if (text === '' && thinking === '' && tools.length === 0) {
        presencePending = false
        continue
      }
      messages.push({
        id: ev.data.message?.id, kind: 'assistant',
        content: text,
        ...(thinking !== '' ? { thinking } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        origin: presencePending ? 'presence' : 'assistant', time,
      })
      msgIndexByStep.set(stepKey, messages.length - 1)
      presencePending = false
    }
  }
  return messages
}

/** 命中并处理返回 true；未命中返回 false 交回分发器。 */
export async function handleHistory(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: WebHandlerDeps,
): Promise<boolean> {
  // /api/history —— 当前会话消息历史（重启后恢复界面）
  if (pathname !== '/api/history' || req.method !== 'GET') return false
  let all: Array<Record<string, unknown>> = []
  try {
    // 事件源优先级：在场 agent 的内存会话日志 > 落盘回放。落盘只在 turn 末
    // checkpoint，turn 进行中读盘会缺「刚发出的用户消息」——webview 此刻重载
    // 后按此重建消息池，那条消息就永久消失（SSE 不重放、非空池不补拉）。
    // 内存日志 turn 中途也完整，且消息 id 与 SSE 广播一致（前端按 id 对账）。
    // 无 agent（本进程尚未开聊）时不存在未 checkpoint 的尾巴，回退落盘。
    const liveEvents = deps.state.agent?.session.events
    const events =
      liveEvents ?? deps.ctx.sessionPersistence.prepare(SessionId(SESSION_ID)) ?? []
    // 群发言落账在产品自有存储里（不在会话日志）——按时间并入重建结果。
    all = mergeGroupSent(
      buildHistoryMessages(events as readonly ReplayEvent[]),
      readGroupSent(groupSentPath()),
    )
  } catch { /* 会话尚不存在 */ }
  // 分页：rounds=N 尾窗（打开只加载最近几轮）/ before 锚点向前取块（懒加载）。
  // 无参数保持旧约定（末尾 200 条）。
  const query = parseHistoryQuery(req.url)
  const page =
    query.rounds !== undefined
      ? roundTail(all, query.rounds)
      : query.before !== undefined || query.beforeTime !== undefined
        ? chunkBefore(all, query)
        : { list: all.slice(-200), hasMore: false }
  sendJson(res, 200, { messages: page.list, hasMore: page.hasMore })
  return true
}
