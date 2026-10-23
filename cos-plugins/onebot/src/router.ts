// @diver/onebot — 入站路由（群/私聊 → 缓冲 → 触发 → 唤醒）。
//
// 持有每群门控状态、锚点、发送记账与 debounce 定时器；唤醒只做一件事：
// 拼窗口快照 → companion.message → agent.followup（安全收权由 index.ts 的
// 回合沙箱钩子负责）。

import type { Agent, UserMessage } from '@cos/plugin-api'

import { PLAIN_DEBOUNCE_MS, type ResolvedConfig } from './config.ts'
import { appendMessage, groupBufferPath, privateBufferPath, readMessages } from './buffer-store.ts'
import { formatWake, selectWindow, type BufferedMessage, type WakeKind } from './context.ts'
import {
  atsUser,
  mentionsAlias,
  repliesTo,
  segmentsToText,
  senderName,
  toSegments,
  type GroupMessageEvent,
  type PrivateMessageEvent,
} from './protocol.ts'
import {
  evaluateGate,
  evaluateTrigger,
  newGateState,
  plainRateForHour,
  recordTurnOutcome,
  type GateState,
} from './trigger.ts'
import type { OnebotClient } from './ws.ts'
import type { TriggerAnchor } from './tools.ts'

/** backend 的 CompanionService 形状（ctx.companion；本地声明避免跨包类型耦合）。 */
export interface CompanionLike {
  agent(): Promise<Agent>
  message(text: string, detail?: string, id?: string): UserMessage
}

/** 引用锚点可回溯的最长时间：群缺省值只认 10 分钟内的触发。 */
const ANCHOR_MAX_AGE_MS = 10 * 60_000

export interface RouterDeps {
  companion: CompanionLike
  cfg: ResolvedConfig
  client: OnebotClient
}

export interface Router {
  handleGroup(event: GroupMessageEvent): Promise<void>
  handlePrivate(event: PrivateMessageEvent): Promise<void>
  /** 工具侧记账：本回合实际发言（沉默退避结算用）。 */
  noteSpoke(): void
  /** turn/end：结算普通档唤醒的回合结局。 */
  settleTurn(): void
  anchor(groupId?: string): TriggerAnchor | undefined
  rememberSent(groupId: string, messageId: number): void
  clearTimers(): void
}

export function createRouter(deps: RouterDeps): Router {
  const { companion, cfg, client } = deps
  const gates = new Map<string, GateState>()
  const groupNames = new Map<string, string>()
  const sentIds = new Map<string, Set<number>>()
  const anchors = new Map<string, TriggerAnchor>()
  const plainTimers = new Map<string, NodeJS.Timeout>()
  // 普通档门控放行后尚未落定的回合（单槽近似：冷却窗口天然稀疏）
  let awaiting: { groupId: string; spoke: boolean } | undefined
  let lastAnchor: TriggerAnchor | undefined

  const gateOf = (groupId: string): GateState => {
    let state = gates.get(groupId)
    if (state === undefined) {
      state = newGateState()
      gates.set(groupId, state)
    }
    return state
  }

  const timeOf = (seconds: number): number => (seconds > 1e12 ? seconds : seconds * 1000)

  async function groupNameOf(groupId: string): Promise<string> {
    const cached = groupNames.get(groupId)
    if (cached !== undefined) return cached
    let name = `群${groupId}`
    try {
      const data = await client.call<{ group_name?: string }>(
        'get_group_info',
        { group_id: Number(groupId) },
        3000,
      )
      const resolved = String(data?.group_name ?? '').trim()
      if (resolved !== '') name = resolved
    } catch {
      // 拿不到群名用兜底名，不阻断
    }
    groupNames.set(groupId, name)
    return name
  }

  async function wake(input: {
    kind: WakeKind
    group: { id: string; name: string } | null
    senderId: string
    senderName: string
    text: string
    hasTrigger: boolean
    messageId: number
    bufferFile: string
  }): Promise<void> {
    const snapshot = selectWindow(readMessages(input.bufferFile), cfg.context)
    const text = formatWake({
      kind: input.kind,
      group: input.group,
      senderId: input.senderId,
      senderName: input.senderName,
      text: input.text,
      isTrigger: input.hasTrigger,
      snapshot,
    })
    const detail = input.group === null
      ? `onebot:u${input.senderId}`
      : `onebot:g${input.group.id}:${input.senderId || '-'}`
    const messageId = input.messageId > 0
      ? `ob-${input.group === null ? `u${input.senderId}` : `g${input.group.id}`}-${input.messageId}`
      : undefined
    const agent = await companion.agent()
    agent.followup(companion.message(text, detail, messageId))
  }

  async function handleGroup(event: GroupMessageEvent): Promise<void> {
    // 自己的回声（事件自带 self_id，不依赖异步登录信息）
    if (event.user_id === event.self_id) return
    const groupId = String(event.group_id)
    // 群白名单：空 = 不监听任何群（私聊不受限）
    if (!cfg.groups.includes(groupId)) return

    const segments = toSegments(event.message)
    const text = segmentsToText(segments)
    const atMe = atsUser(segments, event.self_id)
    const ourIds = sentIds.get(groupId)
    const quotedMe = ourIds !== undefined && [...ourIds].some((id) => repliesTo(segments, id))
    const alias = mentionsAlias(text, cfg.aliases)
    const kind: WakeKind = atMe ? 'at' : quotedMe ? 'quoted' : alias !== undefined ? 'mention' : 'plain'

    appendMessage(groupBufferPath(groupId), {
      time: timeOf(event.time),
      userId: String(event.user_id),
      name: senderName(event.sender),
      text,
      messageId: event.message_id,
      atMe,
    } satisfies BufferedMessage)

    if (kind === 'plain') {
      schedulePlain(groupId)
      return
    }
    if (!evaluateTrigger({ kind, windowCount: 0 }, cfg, Math.random()).fire) return

    const anchor: TriggerAnchor = { groupId, messageId: event.message_id, at: Date.now() }
    anchors.set(groupId, anchor)
    lastAnchor = anchor
    await wake({
      kind,
      group: { id: groupId, name: await groupNameOf(groupId) },
      senderId: String(event.user_id),
      senderName: senderName(event.sender),
      text,
      hasTrigger: true,
      messageId: event.message_id,
      bufferFile: groupBufferPath(groupId),
    })
  }

  async function handlePrivate(event: PrivateMessageEvent): Promise<void> {
    if (event.user_id === event.self_id) return
    const userId = String(event.user_id)
    const text = segmentsToText(toSegments(event.message))
    // 私聊回合不继承群锚点（避免把该发私聊的话误发到旧群）
    lastAnchor = undefined
    appendMessage(privateBufferPath(userId), {
      time: timeOf(event.time),
      userId,
      name: senderName(event.sender),
      text,
      messageId: event.message_id,
      atMe: false,
    } satisfies BufferedMessage)
    await wake({
      kind: 'private',
      group: null,
      senderId: userId,
      senderName: senderName(event.sender),
      text,
      hasTrigger: true,
      messageId: event.message_id,
      bufferFile: privateBufferPath(userId),
    })
  }

  /** 普通消息不即时判定：等话头停顿（debounce）再评估门控与抽样。 */
  function schedulePlain(groupId: string): void {
    const existing = plainTimers.get(groupId)
    if (existing !== undefined) clearTimeout(existing)
    plainTimers.set(groupId, setTimeout(() => {
      plainTimers.delete(groupId)
      void evaluatePlain(groupId)
    }, PLAIN_DEBOUNCE_MS))
  }

  async function evaluatePlain(groupId: string): Promise<void> {
    if (!evaluateGate(gateOf(groupId), cfg, Date.now()).open) return
    if (Math.random() >= plainRateForHour(cfg.rate.plain, new Date())) return
    awaiting = { groupId, spoke: false }
    // 无触发消息的锚点：让本轮 send_qq_group 缺省落到这个群（不引用）
    lastAnchor = { groupId, messageId: 0, at: Date.now() }
    await wake({
      kind: 'plain',
      group: { id: groupId, name: await groupNameOf(groupId) },
      senderId: '',
      senderName: '',
      text: '',
      hasTrigger: false,
      messageId: 0,
      bufferFile: groupBufferPath(groupId),
    })
  }

  return {
    handleGroup,
    handlePrivate,
    noteSpoke: () => {
      if (awaiting !== undefined) awaiting.spoke = true
    },
    settleTurn: () => {
      if (awaiting === undefined) return
      recordTurnOutcome(gateOf(awaiting.groupId), awaiting.spoke, Date.now())
      awaiting = undefined
    },
    anchor: (groupId) => {
      if (groupId !== undefined) {
        const hit = anchors.get(groupId)
        return hit !== undefined && Date.now() - hit.at <= ANCHOR_MAX_AGE_MS ? hit : undefined
      }
      return lastAnchor !== undefined && Date.now() - lastAnchor.at <= ANCHOR_MAX_AGE_MS
        ? lastAnchor
        : undefined
    },
    rememberSent: (groupId, messageId) => {
      let ids = sentIds.get(groupId)
      if (ids === undefined) {
        ids = new Set()
        sentIds.set(groupId, ids)
      }
      ids.add(messageId)
      if (awaiting !== undefined) awaiting.spoke = true
    },
    clearTimers: () => {
      for (const timer of plainTimers.values()) clearTimeout(timer)
      plainTimers.clear()
    },
  }
}
