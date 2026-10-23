// @diver/onebot — OneBot 回合沙箱（纯逻辑）。
//
// 判定粒度是「回合」而非「消息」：同一陪伴会话既服务本地桌面又服务 QQ，
// 工具可见性与执行许可按回合动态切换。两条防线：
//  1) 可见性：system-prompt/assemble 时过滤 assembly.tools（模型看不到）
//  2) 执行：tools/pre-execute 时否决（提示注入点名调用也调不动）
// 混合批次保守：一批认领消息里混有 OneBot 消息 → 整回合按受限处理。

import { BASELINE_TOOLS } from './config.ts'

/** 来源 detail 前缀（companion.message 约定，backend CompanionService 同形）。 */
export const ONEBOT_DETAIL_PREFIX = 'onebot:'

export function isOnebotDetail(detail: string | undefined): boolean {
  return typeof detail === 'string' && detail.startsWith(ONEBOT_DETAIL_PREFIX)
}

/** 回合沙箱状态机：claimed 置位 → turn/end 清除。 */
export class TurnSandbox {
  private active = false

  /** 一批被认领的消息；任一来自 OneBot 即激活本回合受限态。 */
  markClaimed(messages: ReadonlyArray<{ source?: { detail?: string } }>): void {
    if (this.active) return
    for (const message of messages) {
      if (isOnebotDetail(message.source?.detail)) {
        this.active = true
        return
      }
    }
  }

  markTurnEnd(): void {
    this.active = false
  }

  isActive(): boolean {
    return this.active
  }
}

/** 受限回合的全量放行名单 = 基座 + 配置增量（去重）。 */
export function allowedToolNames(extra: readonly string[]): string[] {
  return [...new Set([...BASELINE_TOOLS, ...extra])]
}

/** 可见性过滤（保持原顺序）；非受限回合原样返回。 */
export function filterToolsForTurn<T extends { name?: string; function?: { name?: string } }>(
  tools: readonly T[],
  active: boolean,
  allowed: readonly string[],
): T[] {
  if (!active) return [...tools]
  const allow = new Set(allowed)
  return tools.filter((tool) => {
    const name = tool.name ?? tool.function?.name ?? ''
    return allow.has(name)
  })
}

/** 执行否决：受限回合里不在名单的工具给出拒因；放行返回 undefined。 */
export function vetoIfActive(name: string, active: boolean, allowed: readonly string[]): string | undefined {
  if (!active) return undefined
  if (allowed.includes(name)) return undefined
  return `当前回合来自外部聊天（OneBot），工具 "${name}" 不可用。可用工具仅限：${allowed.join('、')}。`
}
