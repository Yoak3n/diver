// @diver/onebot — 入站路由（群/私聊 → 缓冲 → 触发 → 唤醒）。
//
// 持有每群门控状态、锚点、发送记账与 debounce 定时器；唤醒只做一件事：
// 拼窗口快照 → companion.message → 按 deliveryTier 投递（忙且来源域一致时
// 触发类 steer 插话、其余 followup 排队；安全收权由 index.ts 的回合沙箱钩子负责）。

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
  type Segment,
} from './protocol.ts'
import { collectWakeImages, type WakeImages } from './image.ts'
import { createPrivateNameResolver } from './peer-name.ts'
import {
  deliveryTier,
  evaluateGate,
  evaluatePrivateGate,
  evaluateTrigger,
  newGateState,
  newPrivateGate,
  opportunityRate,
  recordTurnOutcome,
  shouldRetryTurn,
  type DeliveryTier,
  type GateState,
  type PrivateGate,
} from './trigger.ts'
import type { OnebotClient } from './ws.ts'
import type { OnebotSource } from './sandbox.ts'
import type { TriggerAnchor } from './tools.ts'

/** backend 的 CompanionService 形状（ctx.companion；本地声明避免跨包类型耦合）。 */
export interface CompanionLike {
  agent(): Promise<Agent>
  message(
    text: string,
    detail?: string,
    id?: string,
    images?: ReadonlyArray<{ mime: string; data: string; name?: string }>,
  ): UserMessage
}

/** 引用锚点可回溯的最长时间：群缺省值只认 10 分钟内的触发。 */
const ANCHOR_MAX_AGE_MS = 10 * 60_000

/**
 * 触发回合异常结束后的整回合重排延迟。模型请求自身已有退避重试
 * （llm-retry），这里是它用尽后的最后一搏；给上游一点恢复时间。
 */
const TURN_RETRY_DELAY_MS = 1500

/** 重排时注入的提示：原始消息仍在会话里，只要指明回应对象，避免重复已发内容。 */
const TURN_RETRY_HINT =
  '[OneBot 重试] 上一回合在请求模型时失败中断。请直接回应最近一条来自本会话的消息；'
  + '已经发出过的内容不要重复。'

/**
 * 机会档待评估候选：debounce 结束后按「最后一条消息」决定档位。
 * plain 无触发正文（空 sender/text/segments）；owner 带主人那条消息，
 * 让模型知道是谁在说话。
 */
interface Opportunity {
  kind: 'plain' | 'owner'
  senderId: string
  senderName: string
  text: string
  messageId: number
  segments: readonly Segment[] | null
}

/** 触发类唤醒的在途回合：turn/end 时核对是否真的出话、异常时整回合重排一次。 */
interface PendingTrigger {
  kind: WakeKind
  target: string
  tier: DeliveryTier
  at: number
  /** 原消息来源 detail：重排消息沿用，沙箱/记忆作用域保持一致。 */
  detail: string
  /** 已经整回合重排过一次。 */
  retried: boolean
}

export interface RouterDeps {
  companion: CompanionLike
  cfg: ResolvedConfig
  client: OnebotClient
  /** 忙时插话准入：来源域与当前回合一致才允许 steer（沙箱/记忆作用域按回合唯一）。 */
  canSteer: (source: OnebotSource) => boolean
}

export interface Router {
  handleGroup(event: GroupMessageEvent): Promise<void>
  handlePrivate(event: PrivateMessageEvent): Promise<void>
  /** 工具侧记账：本回合实际发言（沉默退避结算用）。 */
  noteSpoke(): void
  /** turn/end：结算机会档（plain/owner）唤醒的回合结局；source = 刚结束回合的来源。 */
  settleTurn(source: OnebotSource | undefined, reason?: { kind: string }): void
  anchor(groupId?: string): TriggerAnchor | undefined
  rememberSent(groupId: string, messageId: number): void
  /** 群号 → 群名（RPC + 缓存，兜底 `群<id>`；自己发言落账署名用）。 */
  groupName(groupId: string): Promise<string>
  clearTimers(): void
}

export function createRouter(deps: RouterDeps): Router {
  const { companion, cfg, client, canSteer } = deps
  // 私聊 sender 常缺 nickname（NapCat）：事件名 → API → 号码，缓存复用。
  const privateNameOf = createPrivateNameResolver(client)
  const gates = new Map<string, GateState>()
  /** 主人普通档的独立门控（短冷却，不被群聊 15 分钟窗口压住）。 */
  const ownerGates = new Map<string, GateState>()
  const privateGates = new Map<string, PrivateGate>()
  const groupNames = new Map<string, string>()
  const sentIds = new Map<string, Set<number>>()
  const anchors = new Map<string, TriggerAnchor>()
  const opportunityTimers = new Map<string, NodeJS.Timeout>()
  const pendingOpportunity = new Map<string, Opportunity>()
  // 机会档门控放行后尚未落定的回合（单槽近似：冷却窗口天然稀疏）
  let awaiting: { groupId: string; kind: Opportunity['kind']; spoke: boolean } | undefined
  /** 最近一次实际出话时刻；触发回合结束时据此判断有没有真的回。 */
  let lastSpokeAt = 0
  /** 最近一次触发类唤醒（at/mention/quoted/private），供 turn/end 核对出话。 */
  let pendingTrigger: PendingTrigger | undefined
  /** 在途的整回合重排（异常结束后的最后一搏）；新唤醒会取消它。 */
  let retryTimer: NodeJS.Timeout | undefined
  let lastAnchor: TriggerAnchor | undefined

  const gateOf = (groupId: string): GateState => {
    let state = gates.get(groupId)
    if (state === undefined) {
      state = newGateState()
      gates.set(groupId, state)
    }
    return state
  }

  const ownerGateOf = (groupId: string): GateState => {
    let state = ownerGates.get(groupId)
    if (state === undefined) {
      state = newGateState()
      ownerGates.set(groupId, state)
    }
    return state
  }

  const privateGateOf = (userId: string): PrivateGate => {
    let state = privateGates.get(userId)
    if (state === undefined) {
      state = newPrivateGate()
      privateGates.set(userId, state)
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
    /** 触发消息段（普通档无触发消息给 null，不取图）。 */
    segments: readonly Segment[] | null
  }): Promise<void> {
    // 新消息到了：让新回合/新触发接管，放弃上一回合的整回合重排。
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
      if (pendingTrigger?.retried === true) pendingTrigger = undefined
    }
    const snapshot = selectWindow(readMessages(input.bufferFile), cfg.context)
    const collected: WakeImages = input.segments === null
      ? { images: [], notes: [] }
      : await collectWakeImages(input.segments, { client })
    // 纯图无文字：正文给兜底文案，模型才知道图是这条消息的主体
    const triggerText = input.text !== ''
      ? input.text
      : collected.images.length > 0 ? '（对方只发了一张图片，未配文字）' : ''
    const noteSuffix = collected.notes.length > 0
      ? `\n（图片获取提示：${collected.notes.join('；')}）`
      : ''
    const text = formatWake({
      kind: input.kind,
      group: input.group,
      senderId: input.senderId,
      senderName: input.senderName,
      text: triggerText + noteSuffix,
      isTrigger: input.hasTrigger,
      snapshot,
    })
    const detail = input.group === null
      ? `onebot:u${input.senderId}`
      : `onebot:g${input.group.id}:${input.senderId || '-'}`
    const messageId = input.messageId !== 0
      ? `ob-${input.group === null ? `u${input.senderId}` : `g${input.group.id}`}-${input.messageId}`
      : undefined
    const agent = await companion.agent()
    const message = companion.message(text, detail, messageId, collected.images)
    // 插话准入 = 忙 + 来源域一致：沙箱与记忆作用域都是一回合一个来源，
    // 跨来源合批会让后到消息借用先到来源的工具面与记忆命名空间。
    const source: OnebotSource = input.group === null
      ? { kind: 'private', userId: input.senderId }
      : { kind: 'group', groupId: input.group.id, userId: input.senderId }
    const steerable = agent.status === 'running' && canSteer(source)
    const tier = deliveryTier(input.kind, steerable)
    // 唤醒留痕（stdout 才落 app.log）：「为什么没回」先确认这一行有没有出现。
    console.log(
      `[onebot] 唤醒 kind=${input.kind} `
      + `${input.group === null ? `私聊=u${input.senderId}` : `群=${input.group.id}`} `
      + `sender=${input.senderId || '-'} → ${tier}`,
    )
    // 触发类唤醒应当出话；回合结束时（settleTurn）核对是否真的调用过出话工具。
    if (input.kind !== 'plain' && input.kind !== 'owner') {
      pendingTrigger = {
        kind: input.kind,
        target: input.group === null ? `u${input.senderId}` : `g${input.group.id}`,
        tier,
        at: Date.now(),
        detail,
        retried: false,
      }
    }
    if (tier === 'steer') agent.steer(message)
    else agent.followup(message)
  }

  async function handleGroup(event: GroupMessageEvent): Promise<void> {
    // 自己的回声（事件自带 self_id，不依赖异步登录信息）
    if (event.user_id === event.self_id) return
    const groupId = String(event.group_id)
    // 群白名单：空 = 不监听任何群（私聊不受限）
    if (!cfg.groups.includes(groupId)) return

    const segments = toSegments(event.message)
    const text = segmentsToText(segments)
    const senderId = String(event.user_id)
    const name = senderName(event.sender)
    const atMe = atsUser(segments, event.self_id)
    const ourIds = sentIds.get(groupId)
    const quotedMe = ourIds !== undefined && [...ourIds].some((id) => repliesTo(segments, id))
    const alias = mentionsAlias(text, cfg.aliases)
    // 档位优先级：@ > 引用我方 > 别名提及 > 主人普通发言 > 普通群聊
    let kind: WakeKind
    if (atMe) kind = 'at'
    else if (quotedMe) kind = 'quoted'
    else if (alias !== undefined) kind = 'mention'
    else if (cfg.ownerIds.includes(senderId)) kind = 'owner'
    else kind = 'plain'

    appendMessage(groupBufferPath(groupId), {
      time: timeOf(event.time),
      userId: senderId,
      name,
      text,
      messageId: event.message_id,
      atMe,
    } satisfies BufferedMessage)

    if (kind === 'plain' || kind === 'owner') {
      scheduleOpportunity(groupId, kind === 'owner'
        ? { kind, senderId, senderName: name, text, messageId: event.message_id, segments }
        : { kind, senderId: '', senderName: '', text: '', messageId: 0, segments: null })
      return
    }
    if (!evaluateTrigger({ kind, windowCount: 0 }, cfg, Math.random()).fire) {
      // @/私聊必回，抽样未中只会出现在 mention/quoted 档
      console.log(`[onebot] 采样未中 kind=${kind} 群=${groupId}`)
      return
    }

    const anchor: TriggerAnchor = { groupId, messageId: event.message_id, at: Date.now() }
    anchors.set(groupId, anchor)
    lastAnchor = anchor
    await wake({
      kind,
      group: { id: groupId, name: await groupNameOf(groupId) },
      senderId,
      senderName: name,
      text,
      hasTrigger: true,
      messageId: event.message_id,
      bufferFile: groupBufferPath(groupId),
      segments,
    })
  }

  async function handlePrivate(event: PrivateMessageEvent): Promise<void> {
    if (event.user_id === event.self_id) return
    const userId = String(event.user_id)
    const segments = toSegments(event.message)
    const text = segmentsToText(segments)
    // 私聊回合不继承群锚点（避免把该发私聊的话误发到旧群）
    lastAnchor = undefined
    // 先解析显示名再落缓冲：来源章与背景窗都不要出现「号码(号码)」。
    const name = await privateNameOf(userId, event.sender)
    appendMessage(privateBufferPath(userId), {
      time: timeOf(event.time),
      userId,
      name,
      text,
      messageId: event.message_id,
      atMe: false,
    } satisfies BufferedMessage)
    // 必回但有配额：刷屏者在小时内被静默（只记缓冲，不唤醒回合）
    if (!evaluatePrivateGate(privateGateOf(userId), cfg.privateMaxPerHour, Date.now()).open) return
    await wake({
      kind: 'private',
      group: null,
      senderId: userId,
      senderName: name,
      text,
      hasTrigger: true,
      messageId: event.message_id,
      bufferFile: privateBufferPath(userId),
      segments,
    })
  }

  /** 普通/主人消息不即时判定：等话头停顿（debounce）再按最后一条消息的档位评估。 */
  function scheduleOpportunity(groupId: string, candidate: Opportunity): void {
    pendingOpportunity.set(groupId, candidate)
    const existing = opportunityTimers.get(groupId)
    if (existing !== undefined) clearTimeout(existing)
    opportunityTimers.set(groupId, setTimeout(() => {
      opportunityTimers.delete(groupId)
      void evaluateOpportunity(groupId)
    }, PLAIN_DEBOUNCE_MS))
  }

  async function evaluateOpportunity(groupId: string): Promise<void> {
    const candidate = pendingOpportunity.get(groupId)
    pendingOpportunity.delete(groupId)
    if (candidate === undefined) return
    const owner = candidate.kind === 'owner'
    const gate = owner ? ownerGateOf(groupId) : gateOf(groupId)
    const cooldown = owner ? cfg.ownerCooldownMinutes : cfg.cooldownMinutes
    const decision = evaluateGate(gate, cooldown, Date.now())
    if (!decision.open) {
      console.log(`[onebot] 机会档未唤醒 kind=${candidate.kind} 群=${groupId} 原因=${decision.reason ?? 'gate'}`)
      return
    }
    const rate = opportunityRate(candidate.kind, cfg, new Date())
    if (Math.random() >= rate) {
      console.log(`[onebot] 机会档抽样未中 kind=${candidate.kind} 群=${groupId} 概率=${rate}`)
      return
    }
    awaiting = { groupId, kind: candidate.kind, spoke: false }
    // 锚点：主人档引用那条消息；普通档缺省落到本群（不引用）
    lastAnchor = { groupId, messageId: candidate.messageId, at: Date.now() }
    await wake({
      kind: candidate.kind,
      group: { id: groupId, name: await groupNameOf(groupId) },
      senderId: candidate.senderId,
      senderName: candidate.senderName,
      text: candidate.text,
      hasTrigger: owner,
      messageId: candidate.messageId,
      bufferFile: groupBufferPath(groupId),
      segments: candidate.segments,
    })
  }

  /**
   * 模型请求失败、触发回合又没出话：给上游一点恢复时间后整回合重排一次。
   * 原始消息仍在会话里，这里只补一条「继续回应」的提示，不重复入站内容。
   */
  function scheduleTurnRetry(trigger: PendingTrigger): void {
    pendingTrigger = { ...trigger, at: Date.now(), retried: true }
    console.log(
      `[onebot] 回合异常结束，${TURN_RETRY_DELAY_MS}ms 后重排一次 `
      + `kind=${trigger.kind} ${trigger.target}`,
    )
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void (async () => {
        try {
          const agent = await companion.agent()
          // 沿用原 detail：沙箱/记忆作用域仍是同一来源，出话工具照常可用。
          agent.followup(companion.message(TURN_RETRY_HINT, trigger.detail))
        } catch (error) {
          console.log(`[onebot] 重排唤醒失败 ${trigger.target}: ${String(error)}`)
        }
      })()
    }, TURN_RETRY_DELAY_MS)
  }

  return {
    handleGroup,
    handlePrivate,
    noteSpoke: () => {
      lastSpokeAt = Date.now()
      if (awaiting !== undefined) awaiting.spoke = true
    },
    settleTurn: (source, reason) => {
      const target = source === undefined
        ? undefined
        : source.kind === 'group' ? `g${source.groupId}` : `u${source.userId}`
      if (pendingTrigger !== undefined && target !== undefined && pendingTrigger.target === target) {
        const trigger = pendingTrigger
        pendingTrigger = undefined
        // 触发类回合（@/提及/引用/私聊）没调用出话工具：只在桌面端说了话，QQ 里无声
        const spoke = lastSpokeAt >= trigger.at
        if (!spoke) {
          if (shouldRetryTurn(reason, trigger.retried, spoke)) {
            scheduleTurnRetry(trigger)
          } else {
            console.log(
              `[onebot] 回合结束未见出话 kind=${trigger.kind} ${trigger.target} 投递=${trigger.tier}`
              + `${trigger.retried ? '（重排后仍未出话）' : `（结束原因=${reason?.kind ?? '未知'}）`}`,
            )
          }
        }
      }
      if (awaiting === undefined) return
      // 机会档只属于群；来源对不上（别的群/私聊/桌面回合）不结算，避免记错账
      if (target !== `g${awaiting.groupId}`) return
      const gate = awaiting.kind === 'owner' ? ownerGateOf(awaiting.groupId) : gateOf(awaiting.groupId)
      recordTurnOutcome(gate, awaiting.spoke, Date.now())
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
      // 本群刚发过言：普通档冷却从现在重计，避免紧接着又被群聊唤醒
      gateOf(groupId).lastFireAt = Date.now()
    },
    groupName: groupNameOf,
    clearTimers: () => {
      for (const timer of opportunityTimers.values()) clearTimeout(timer)
      opportunityTimers.clear()
      pendingOpportunity.clear()
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
    },
  }
}
