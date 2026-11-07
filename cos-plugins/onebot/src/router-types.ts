// @diver/onebot — 路由层公共类型与路由常量。
//
// 只放形状、签名与行为常量；状态机在 trigger.ts，闭包在 router.ts。
// 拆出来是为了让 router.ts 守住 500 行硬限（AGENTS.md）。

import type { Agent, UserMessage } from '@cos/plugin-api'

import type { ResolvedConfig } from './config.ts'
import type { WakeKind } from './context.ts'
import type { GroupMessageEvent, PrivateMessageEvent, Segment } from './protocol.ts'
import type { OnebotSource } from './sandbox.ts'
import type { DeliveryTier } from './trigger.ts'
import type { TriggerAnchor } from './tools.ts'
import type { OnebotClient } from './ws.ts'

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
export const ANCHOR_MAX_AGE_MS = 10 * 60_000

/**
 * 触发回合异常结束后的整回合重排延迟。模型请求自身已有退避重试
 * （llm-retry），这里是它用尽后的最后一搏；给上游一点恢复时间。
 */
export const TURN_RETRY_DELAY_MS = 1500

/** 重排时注入的提示：原始消息仍在会话里，只要指明回应对象，避免重复已发内容。 */
export const TURN_RETRY_HINT =
  '[OneBot 重试] 上一回合在请求模型时失败中断。请直接回应最近一条来自本会话的消息；'
  + '已经发出过的内容不要重复。'

/** 重排也用尽后的兜底提示：触发类回合异常结束时，聊天里至少有一句可见反馈。 */
export const TURN_FAIL_NOTICE = '（刚才请求模型失败了，这条消息没处理成功，稍后再发一次试试）'

/**
 * 机会档待评估候选：debounce 结束后按「最后一条消息」决定档位。
 * plain 无触发正文（空 sender/text/segments）；owner 带主人那条消息，
 * 让模型知道是谁在说话。
 */
export interface Opportunity {
  kind: 'plain' | 'owner'
  senderId: string
  senderName: string
  text: string
  messageId: number
  segments: readonly Segment[] | null
}

/** 触发类唤醒的在途回合：turn/end 时核对是否真的出话、异常时整回合重排一次。 */
export interface PendingTrigger {
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
