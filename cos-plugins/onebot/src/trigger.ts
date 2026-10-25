// @diver/onebot — 触发策略（纯函数 + 无 IO 状态机）。
//
// 档位（调研拍板，见方案）：被 @ 与私聊必回；提及/引用按概率；普通群消息
// 概率最低且过「冷却 + 沉默退避」门控。门控状态按群隔离。

import type { ResolvedConfig } from './config.ts'
import { BACKOFF_BASE_MS, BACKOFF_BYPASS_COUNT, BACKOFF_CAP_MS, BACKOFF_START_STREAK } from './config.ts'

export type TriggerKind = 'at' | 'mention' | 'quoted' | 'plain' | 'private'

/** 单条群消息的触发判据（index.ts 组装，evaluate 消费）。 */
export interface TriggerInput {
  kind: TriggerKind
  /** 普通档专用：评估时刻该群自上次主动发言以来的新消息数。 */
  windowCount: number
}

export interface TriggerOutcome {
  fire: boolean
  /** 命中的档位（fire=false 时也带出，供日志）。 */
  kind: TriggerKind
}

/**
 * 档位判定：at/private 必回；mention/quoted/plain 抽样。
 * roll 由调用方注入（可测）；返回 0~1。
 */
export function evaluateTrigger(input: TriggerInput, cfg: ResolvedConfig, roll: number): TriggerOutcome {
  const { kind } = input
  if (kind === 'at' || kind === 'private') return { fire: true, kind }
  const rate = kind === 'mention' ? cfg.rate.mention : kind === 'quoted' ? cfg.rate.quoted : cfg.rate.plain
  if (roll < rate) return { fire: true, kind }
  return { fire: false, kind }
}

// ---- 唤醒投递档位 ----

/** 投递档位：followup = 排队 next-turn；steer = 忙时插话 next-step（step 边界认领）。 */
export type DeliveryTier = 'followup' | 'steer'

/**
 * 投递档位判定：steerable（忙 + 来源域一致，见 canSteerInto）时触发类
 * （at/mention/quoted/private）插话——消息在下一个 step 边界被认领进当前
 * 回合，模型可当场以 send_qq_* 工具回复，不必等整个回合跑完。plain 档、
 * 空闲态与跨来源一律 next-turn：机会性插话不挤占忙回合，跨来源合批会
 * 破坏「一回合一个来源」的沙箱/记忆作用域前提。
 */
export function deliveryTier(kind: TriggerKind, steerable: boolean): DeliveryTier {
  return steerable && kind !== 'plain' ? 'steer' : 'followup'
}

// ---- 普通档门控状态（每群一份） ----

export interface GateState {
  /** 上次主动插话（fire）时刻，毫秒；0 = 从未。 */
  lastFireAt: number
  /** 连续「门开但模型沉默」次数（turn 结束无发言）。 */
  silentStreak: number
  /** 退避截止时刻，毫秒；0 = 不在退避。 */
  backoffUntil: number
  /** 进入退避以来攒下的新消息数（达到 BYPASS 提前重估）。 */
  pendingInBackoff: number
}

export function newGateState(): GateState {
  return { lastFireAt: 0, silentStreak: 0, backoffUntil: 0, pendingInBackoff: 0 }
}

export interface GateDecision {
  /** 通过门控，进入概率抽样。 */
  open: boolean
  /** 拒因（日志用）：cooldown / backoff。 */
  reason?: 'cooldown' | 'backoff'
}

/**
 * 冷却 + 退避门控（只约束 plain 档）。退避等待期攒够新消息可提前重估；
 * 通过门控即记 lastFireAt（抽样失败也重记：本轮机会已用掉，防连发）。
 */
export function evaluateGate(state: GateState, cfg: ResolvedConfig, now: number): GateDecision {
  if (state.lastFireAt > 0) {
    const cooldownMs = cfg.cooldownMinutes * 60_000
    if (now - state.lastFireAt < cooldownMs) return { open: false, reason: 'cooldown' }
  }
  if (now < state.backoffUntil) {
    if (state.pendingInBackoff + 1 < BACKOFF_BYPASS_COUNT) {
      state.pendingInBackoff += 1
      return { open: false, reason: 'backoff' }
    }
    // 攒够了：清账放行（本次评估即消费等待窗）。
    state.pendingInBackoff = 0
  }
  state.lastFireAt = now
  return { open: true }
}

/** 连续沉默退避时长：第 2 连开始 15s 起指数拉长，300s 封顶。 */
export function nextBackoffMs(silentStreak: number): number {
  if (silentStreak < BACKOFF_START_STREAK) return 0
  const exponent = silentStreak - BACKOFF_START_STREAK
  return Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS)
}

/**
 * 回合结局记账：该唤醒回合模型发了言 → 清退避；沉默 → 计连击并设退避。
 * （唤醒→回合的关联与监听在 index.ts，此处纯计算。）
 */
export function recordTurnOutcome(state: GateState, spoke: boolean, now: number): void {
  if (spoke) {
    state.silentStreak = 0
    state.backoffUntil = 0
    state.pendingInBackoff = 0
    return
  }
  state.silentStreak += 1
  const ms = nextBackoffMs(state.silentStreak)
  state.backoffUntil = ms > 0 ? now + ms : 0
  state.pendingInBackoff = 0
}

/**
 * 深夜降档（MaiBot 内置规则的简化）：00:00–08:59 主动插话概率 ×0.8。
 * 只作用于 plain 档抽样前。
 */
export function plainRateForHour(rate: number, date: Date): number {
  const hour = date.getHours()
  return hour < 9 ? rate * 0.8 : rate
}

// ---- 私聊唤醒限频（每用户一份） ----

export interface PrivateGate {
  /** 当前固定窗口起点（毫秒）；0 = 尚未开窗。 */
  windowStart: number
  /** 窗口内已唤醒次数。 */
  count: number
}

export function newPrivateGate(): PrivateGate {
  return { windowStart: 0, count: 0 }
}

/**
 * 私聊限频（固定 1 小时窗口）：私聊必回但不无限回，刷屏者在窗口内被静默
 * （消息仍进缓冲，只是不唤醒回合）。maxPerHour = 0 不限制；窗口滚动即恢复。
 */
export function evaluatePrivateGate(
  state: PrivateGate,
  maxPerHour: number,
  now: number,
): { open: boolean; reason?: 'flood' } {
  if (maxPerHour <= 0) return { open: true }
  if (state.windowStart === 0 || now - state.windowStart >= 3_600_000) {
    state.windowStart = now
    state.count = 0
  }
  if (state.count >= maxPerHour) return { open: false, reason: 'flood' }
  state.count += 1
  return { open: true }
}
