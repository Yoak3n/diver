// @diver/backend — 消息入会话端点：用户聊天 / 已裁决注入 / 实例间 inbox。
// 三条通道都以「构造消息 → 交付 agent（followup/steer/inject）」收口，
// 区别只在来源盖章与唤醒档位。

import { createUserMessage } from '@cos/plugin-api'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { userMessage } from '../agent.ts'
import { appendGroupSent, groupSentEvent, groupSentPath } from '../group-sent.ts'
import type { GroupSentRecord } from '../group-sent.ts'
import { groupMarkerLine, inboxMarkerLine } from '../interaction.ts'
import { readBody, sendJson } from '../http.ts'
import { readDiverSettings } from '../session-helpers.ts'
import { createBroadcast } from '../sse.ts'
import type { WebHandlerDeps } from '../types.ts'

/** 命中并处理返回 true；未命中返回 false 交回分发器。 */
export async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: WebHandlerDeps,
): Promise<boolean> {
  // /api/chat —— 发送一条用户消息（可附带图片）
  if (pathname === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req)
    const content = String(body.content ?? '').trim()
    const rawImages = Array.isArray(body.images) ? body.images : []
    const images: Array<{ mime: string; data: string; name?: string }> = []
    for (const raw of rawImages) {
      if (!raw || typeof raw !== 'object') continue
      const mime = String((raw as { mime?: unknown }).mime ?? '').trim().toLowerCase()
      const data = String((raw as { data?: unknown }).data ?? '').trim()
      const name = String((raw as { name?: unknown }).name ?? '').trim()
      // 只收常见位图；data 为 base64（不含 data: 前缀）
      if (!/^image\/(png|jpe?g|webp|gif)$/.test(mime)) continue
      if (data === '' || data.length > 12_000_000) continue
      images.push({
        mime,
        data: data.replace(/^data:[^,]+,/, ''),
        ...(name !== '' ? { name } : {}),
      })
    }
    if (images.length > 8) images.length = 8
    if (!content && images.length === 0) {
      sendJson(res, 400, { error: '消息不能为空' })
      return true
    }
    // P2-4 群聊广播：body.group = {id, name}（true = 全员群缺省）；会话内注入
    // 「在场 + 不必回复」提示首行（UI 显示时剥离）。不设强制回复：实例自主决定
    // 说不说（stay_silent/空回复出口见 @diver/peer）。
    // body.clientMsgId = 广播方为整次 fan-out 生成的共享 id：各成员会话里的副本
    // 同 id，群合并流按 id 去重（成员忙时领取时间可差几分钟，时间窗靠不住）。
    const clientMsgId =
      typeof body.clientMsgId === 'string' && body.clientMsgId.trim() !== ''
        ? body.clientMsgId.trim()
        : undefined
    const groupInfo =
      typeof body.group === 'object' && body.group !== null
        ? {
            id: String((body.group as { id?: unknown }).id ?? '').trim() || 'general',
            name: String((body.group as { name?: unknown }).name ?? '').trim() || '全员群',
          }
        : body.group === true
          ? { id: 'general', name: '全员群' }
          : null
    const text = groupInfo !== null ? `${groupMarkerLine(groupInfo.name)}\n${content}` : content
    const groupDetail = groupInfo !== null ? `group:${groupInfo.id}` : undefined
    if (deps.state.busy) {
      const agent = await deps.ensureAgent()
      const msg = userMessage(text || '（图片）', images, groupDetail, clientMsgId)
      // P2-3 群聊广播（queue）：忙时排队 next-turn，不插话打断当前回合。
      if (body.queue === true) {
        agent.followup(msg)
        sendJson(res, 200, { sessionId: String(agent.id), messageId: String(msg.id), queued: 'next-turn' })
        return true
      }
      agent.steer(msg)
      sendJson(res, 200, { sessionId: String(agent.id), messageId: String(msg.id), queued: 'next-step' })
      return true
    }
    if (!(await deps.isModelConfigured())) {
      // 区分"已注册但缺凭据"与"未注册/未启用"，给出不同提示。
      const s = readDiverSettings()
      const provider = typeof s.provider === 'string' && s.provider
        ? s.provider
        : (deps.ctx.llm.listProviders()[0]?.id ?? '')
      const registered = provider !== '' && deps.ctx.llm.listProviders().some((p) => p.id === provider)
      sendJson(res, 400, {
        error: registered ? '尚未配置 API Key，请先在设置中配置' : '当前模型提供商未注册或未启用，请在设置中重新选择',
      })
      return true
    }
    const agent = await deps.ensureAgent()
    const msg = userMessage(text || '（图片）', images, groupDetail, clientMsgId)
    agent.followup(msg)
    sendJson(res, 200, { sessionId: String(agent.id), messageId: String(msg.id), queued: false })
    return true
  }

  // /api/inject —— 壳端已裁决注入（无门控 followup；控制面在壳 CompanionPresence）。
  // body: { text, source?: { kind?, detail? }, origin? }
  if (pathname === '/api/inject' && req.method === 'POST') {
    const body = await readBody(req)
    const text = String(body.text ?? '').trim()
    if (!text) {
      sendJson(res, 400, { error: 'text 必填' })
      return true
    }
    const src = (body.source ?? {}) as { kind?: string; detail?: string }
    const kind = src.kind === 'human' || src.kind === 'goal' ? src.kind : 'plugin'
    const detail = String(src.detail ?? body.origin ?? 'proactive')
    const msg = createUserMessage(text, detail ? { kind, detail } : { kind })
    const agent = await deps.ensureAgent()
    agent.followup(msg)
    sendJson(res, 200, {
      sessionId: String(agent.id),
      messageId: String(msg.id),
      queued: false,
      detail,
    })
    return true
  }

  // /api/inbox —— P2-2 互实例消息注入：壳消息路由（services/peer::send）调用，
  // from 由壳按身份头盖章（来源可信，不采信调用方自称）；消息进 session inbox
  // （InboxTarget：next-turn 缺省 / next-step 步间插话 / inject 收听不唤醒）。
  // body: { text, from: { id, name }, target?: 'next-turn' | 'next-step' | 'inject' }
  if (pathname === '/api/inbox' && req.method === 'POST') {
    const body = await readBody(req)
    const text = String(body.text ?? '').trim()
    if (!text) {
      sendJson(res, 400, { error: 'text 必填' })
      return true
    }
    const from = (body.from ?? {}) as { id?: string; name?: string }
    const fromId = String(from.id ?? '').trim()
    if (!fromId) {
      sendJson(res, 400, { error: 'from.id 必填' })
      return true
    }
    const fromName = String(from.name ?? '').trim() || fromId
    // 来源区分（用户拍板）：私聊 / 群发言 / 群邀请分章——收方一眼分出语境。
    const g = (body.group ?? {}) as { id?: string; name?: string }
    const groupId = String(g.id ?? '').trim() || 'general'
    const groupName = String(g.name ?? '').trim() || '全员群'
    const kind = body.kind === 'invite' ? 'invite' : body.kind === 'group' ? 'group' : 'peer'
    // 群发言/私聊 fan-out 共享 id（壳 group::say / peer::send 生成）：发送方落账
    // 与各收方副本同 id，群合并流按 id 去重——收方领取时间不定，时间窗靠不住。
    const clientMsgId =
      typeof body.clientMsgId === 'string' && body.clientMsgId.trim() !== ''
        ? body.clientMsgId.trim()
        : undefined
    const marker = inboxMarkerLine(kind, fromName, fromId, groupName)
    const bodyText =
      kind === 'invite'
        ? `${marker}\n${text}\n请调用 respond_invite(group="${groupId}", accept, reason) 决定接受或拒绝（可以拒绝）。`
        : `${marker}\n${text}`
    const target =
      body.target === 'inject'
        ? 'inject'
        : body.target === 'next-step'
          ? 'next-step'
          : 'next-turn'
    const msg = createUserMessage(
      bodyText,
      {
        kind: 'plugin',
        detail: kind === 'peer' ? `peer:${fromId}` : `${kind}:${groupId}:${fromId}`,
      },
      undefined,
      clientMsgId,
    )
    const agent = await deps.ensureAgent()
    // InboxTarget 三档：followup = next-turn 唤醒；steer = next-step 插话；inject = next-step 不唤醒（群聊收听）。
    // （harness agent-loop 等价实现，接口面只暴露这两档）。
    if (target === 'inject') agent.inject(msg)
    else if (target === 'next-step') agent.steer(msg)
    else agent.followup(msg)
    sendJson(res, 200, { sessionId: String(agent.id), messageId: String(msg.id), queued: target })
    return true
  }

  // /api/group-sent —— 群发言落账（record-only）：壳 group::say fan-out 成功后
  // 调用，把「本条已投递」记进**产品自有存储**（`$COS_HOME/group-sent.jsonl`，
  // 见 ../group-sent.ts）——不进会话日志、不进 inbox、不唤醒、不进模型上下文。
  // 群视图在发送时刻即显示本条（直接广播，不等收方领取）；收方稍后 claim 出的
  // 副本共享 clientMsgId，由前端按 id 去重。
  // body: { text, from: { id, name }, group: { id, name }, clientMsgId }
  if (pathname === '/api/group-sent' && req.method === 'POST') {
    const body = await readBody(req)
    const text = String(body.text ?? '').trim()
    const clientMsgId = String(body.clientMsgId ?? '').trim()
    if (!text || !clientMsgId) {
      sendJson(res, 400, { error: 'text 与 clientMsgId 必填' })
      return true
    }
    const from = (body.from ?? {}) as { id?: string; name?: string }
    const g = (body.group ?? {}) as { id?: string; name?: string }
    const record: GroupSentRecord = {
      text,
      from: { id: String(from.id ?? '').trim(), name: String(from.name ?? '').trim() },
      group: { id: String(g.id ?? '').trim() || 'general', name: String(g.name ?? '').trim() || '全员群' },
      clientMsgId,
      time: Date.now(),
    }
    // 落盘失败不阻断实时显示（壳侧同样只记日志、不影响发言结果）。
    try {
      appendGroupSent(groupSentPath(), record)
    } catch (error) {
      console.warn(`[group-sent] 落账失败（不影响显示）：${String(error)}`)
    }
    const agent = await deps.ensureAgent()
    createBroadcast(deps.state)(groupSentEvent(record, String(agent.id)))
    sendJson(res, 200, { recorded: true, messageId: clientMsgId })
    return true
  }

  return false
}
