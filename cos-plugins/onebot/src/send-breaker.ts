// @diver/onebot — 发送失败熔断（纯逻辑）。
//
// 账号被风控时 send_* 会连续失败；连续失败达到上限后本地短路后续出话
// （不再打实现侧，也不合成语音），让回合停止重试。恢复条件二选一：
// 一次成功发送，或距最近失败静默超过愈合窗（风控通常短暂）。

/** 连续失败达到该次数即熔断。 */
export const SEND_FAIL_LIMIT = 3
/** 熔断愈合窗（毫秒）：距最近失败超过该时长自动恢复。 */
export const BREAKER_HEAL_MS = 5 * 60_000

export class SendBreaker {
  private streak = 0
  private lastFailAt = 0

  /** 是否处于熔断（拒绝发送）。 */
  blocked(now: number): boolean {
    return this.streak >= SEND_FAIL_LIMIT && now - this.lastFailAt < BREAKER_HEAL_MS
  }

  /** 当前连续失败次数（错误文案用）。 */
  failCount(): number {
    return this.streak
  }

  recordOk(): void {
    this.streak = 0
    this.lastFailAt = 0
  }

  recordFail(now: number): void {
    this.streak += 1
    this.lastFailAt = now
  }
}

/** 熔断期间调用发送工具的返回错误文案。 */
export function breakerErrorMessage(count: number): string {
  return `已连续发送失败 ${count} 次，出话暂停（疑似风控）。不要再调用发送工具，直接结束本回合；稍后会自动恢复。`
}
