// @diver/backend — 闲时门控：互动事件 / presence 共用的「主动开口」占坑器。
//
// 只有 agent 空闲、距上一对话静默足够久、距上次主动开口超过冷却时才允许触发。
// chat 会重置闲时窗口计数，避免刚聊完就搭话。

export type ProactiveRejectReason =
  | 'busy'
  | 'recent_chat'
  | 'cooldown'
  | 'disabled'
  | 'deduped'
  | 'max_triggers'

export interface IdleGateConfig {
  /** 距上一条 user/assistant 消息静默多久算「闲」。 */
  quietMs: number
  /** 两次主动开口最小间隔。 */
  cooldownMs: number
  /** 一段闲时窗口内最多主动开口次数。 */
  maxTriggers: number
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: ProactiveRejectReason }

export interface IdleGate {
  /** 对话活动（user/assistant 消息、turn 边界）时调用，推进静默计时。 */
  noteChat(now?: number): void
  /** 真人用户发言：重置闲时窗口计数（主动搭话不会调用这个）。 */
  noteUserChat(now?: number): void
  /** 尝试占一个「主动开口」名额；成功则开始冷却并计数。 */
  tryClaim(now?: number): ClaimResult
  /** 调试快照。 */
  snapshot(now?: number): {
    lastChatAt: number
    lastProactiveAt: number
    windowTriggers: number
  }
}

export function createIdleGate(
  isBusy: () => boolean,
  getConfig: () => IdleGateConfig,
): IdleGate {
  let lastChatAt = 0
  let lastProactiveAt = 0
  let windowTriggers = 0

  return {
    noteChat(now = Date.now()) {
      lastChatAt = now
    },
    noteUserChat(now = Date.now()) {
      lastChatAt = now
      // 真人开口 → 新闲时窗口
      windowTriggers = 0
    },
    tryClaim(now = Date.now()) {
      const { quietMs, cooldownMs, maxTriggers } = getConfig()
      if (isBusy()) return { ok: false, reason: 'busy' }
      // 启动后尚未有过对话：用 lastChatAt=0，quiet 从进程启动算起也可接受；
      // 若从未对话且刚启动，仍要求 quietMs 静默，避免启动瞬间被桌宠误触发。
      if (now - lastChatAt < quietMs) return { ok: false, reason: 'recent_chat' }
      if (lastProactiveAt > 0 && now - lastProactiveAt < cooldownMs) {
        return { ok: false, reason: 'cooldown' }
      }
      if (windowTriggers >= maxTriggers) return { ok: false, reason: 'max_triggers' }
      lastProactiveAt = now
      windowTriggers += 1
      return { ok: true }
    },
    snapshot(now = Date.now()) {
      void now
      return { lastChatAt, lastProactiveAt, windowTriggers }
    },
  }
}

export const DEFAULT_IDLE_GATE: IdleGateConfig = {
  quietMs: 10_000,
  cooldownMs: 45_000,
  maxTriggers: 1,
}
