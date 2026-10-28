// @diver/onebot — OneBot 回合沙箱（纯逻辑）。
//
// 判定粒度是「回合」而非「消息」：同一陪伴会话既服务本地桌面又服务 QQ，
// 工具可见性与执行许可按回合动态切换。三条防线只约束**不可信来源**：
// 群聊（含主人在群里）与陌生私聊。
//  1) 可见性：system-prompt/assemble 时过滤 assembly.tools（模型看不到）
//  2) 执行：tools/pre-execute 时否决（提示注入点名调用也调不动）
//  3) 路径：read/ls/find/grep 四个只读工具「受限可见」，目标路径必须落在
//     fs-jail.ts 的囚笼内（基线扣会话记录与敏感落盘）；
//     append_note 是唯一写入口，只能追加当前来源自己的笔记作用域（notes.ts）。
// **主人私聊是唯一例外**：整回合跳过三条防线，工具面与文件权限和本地桌面一致
// （所有者明确要求主人私聊全权限，不再防主人号被盗）。
// 混合批次保守：一批认领消息里混有 OneBot 消息 → 整回合按受限处理。
//
// 硬禁清单独立于 allowedTools：即使有人把 sh / write / web_read 填进配置，
// 也不会对**受限** QQ 回合开放。

import { BASELINE_TOOLS } from './config.ts'

/** 来源 detail 前缀（companion.message 约定，backend CompanionService 同形）。 */
export const ONEBOT_DETAIL_PREFIX = 'onebot:'

/** 一次 OneBot 回合的来源；群/私聊决定记忆作用域。 */
export type OnebotSource =
  | { kind: 'group'; groupId: string; userId: string }
  | { kind: 'private'; userId: string }

export function isOnebotDetail(detail: string | undefined): detail is string {
  return typeof detail === 'string' && detail.startsWith(ONEBOT_DETAIL_PREFIX)
}

/** 解析 `onebot:g<群号>:<发送者>` / `onebot:u<QQ号>`；坏格式返回 undefined。 */
export function parseOnebotSource(detail: string | undefined): OnebotSource | undefined {
  if (!isOnebotDetail(detail)) return undefined
  const rest = detail.slice(ONEBOT_DETAIL_PREFIX.length)
  if (rest.startsWith('g')) {
    const [groupId = '', userId = ''] = rest.slice(1).split(':')
    if (groupId === '') return undefined
    return { kind: 'group', groupId, userId: userId === '-' ? '' : userId }
  }
  if (rest.startsWith('u')) {
    const userId = rest.slice(1)
    return userId === '' ? undefined : { kind: 'private', userId }
  }
  return undefined
}

/** 回合沙箱状态机：claimed 置位 → turn/end 清除。 */
export class TurnSandbox {
  private source: OnebotSource | undefined

  /**
   * 一批被认领的消息；任一来自 OneBot 即激活本回合受限态。
   * 返回本次「新激活」的来源（已激活时返回 undefined，避免重复广播）。
   */
  markClaimed(messages: ReadonlyArray<{ source?: { detail?: string } }>): OnebotSource | undefined {
    if (this.source !== undefined) return undefined
    for (const message of messages) {
      const source = parseOnebotSource(message.source?.detail)
      if (source !== undefined) {
        this.source = source
        return source
      }
    }
    return undefined
  }

  markTurnEnd(): void {
    this.source = undefined
  }

  isActive(): boolean {
    return this.source !== undefined
  }

  currentSource(): OnebotSource | undefined {
    return this.source
  }
}

/** 本机控制 / 高风险 / 任意 URL 类工具：受限 OneBot 回合永久禁止。 */
export const FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  // 任意 URL 抓取（web_search / web_explore 已覆盖联网需求）
  'web_read',
  // 本地文件写入与 shell（只读四件套 read/ls/find/grep 走 fs-jail.ts 囚笼；
  // 唯一的写入例外是 append_note，它只追加自己的笔记作用域）
  'write', 'edit', 'multi_edit', 'sh',
  // 屏幕
  'screenshot', 'list_displays',
  // 进程 / 实例控制
  'restart_agent', 'native_status',
  // 任务委派
  'delegate_task', 'list_tasks', 'cancel_task', 'get_task_events',
  // 实例间通信
  'send_to_peer', 'send_to_group', 'list_peers', 'list_groups',
  'create_group', 'invite_to_group', 'respond_invite',
  // 记忆身份/全量枚举/删除（recall/remember 已按作用域开放）
  'identity', 'set_name', 'demote', 'inventory',
])

/** MCP 工具语义未知，按前缀整类禁止。 */
const FORBIDDEN_PREFIXES = ['mcp__'] as const

export function isForbiddenTool(name: string): boolean {
  return FORBIDDEN_TOOLS.has(name) || FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** 仅主人发起的回合可用的工具；即使写进 allowedTools 也不会对普通群友开放。 */
export const OWNER_TOOLS = ['revise_prompt', 'list_prompt_slots'] as const

const OWNER_TOOL_SET: ReadonlySet<string> = new Set(OWNER_TOOLS)

export function isOwnerTool(name: string): boolean {
  return OWNER_TOOL_SET.has(name)
}

/** 本回合是否由主人发起（群/私聊都算；无具体发送者的群背景唤醒不算）。 */
export function isOwnerSource(
  source: OnebotSource | undefined,
  ownerIds: readonly string[],
): boolean {
  return source !== undefined && ownerIds.includes(source.userId)
}

/**
 * 本回合是否为主人私聊：OneBot 沙箱的唯一豁免层——工具面与文件权限和本地
 * 桌面一致。主人在**群里**的发言仍走基线——群内有其他听众。
 */
export function isOwnerPrivateSource(
  source: OnebotSource | undefined,
  ownerIds: readonly string[],
): boolean {
  return source?.kind === 'private' && isOwnerSource(source, ownerIds)
}

/**
 * 忙时插话（steer）准入：只有「来源域一致」才允许插入当前回合，否则排队
 * 下一回合（followup）。沙箱与记忆作用域都是「一回合一个来源」，跨来源合批
 * 会让后到消息借用先到来源的工具面（主人专属工具）与记忆命名空间。
 *  - 无活动回合（本地桌面）：不插话，避免中途激活沙箱 / 切换记忆作用域
 *  - 群：同群且主人属性一致（不同群 = 不同命名空间；主人/非主人 = 不同工具面）
 *  - 私聊：同一用户（命名空间按用户隔离）
 */
export function canSteerInto(
  source: OnebotSource,
  current: OnebotSource | undefined,
  ownerIds: readonly string[],
): boolean {
  if (current === undefined) return false
  if (source.kind === 'group' && current.kind === 'group') {
    return source.groupId === current.groupId
      && isOwnerSource(source, ownerIds) === isOwnerSource(current, ownerIds)
  }
  if (source.kind === 'private' && current.kind === 'private') {
    return source.userId === current.userId
  }
  return false
}

/** 受限回合的全量放行名单 = 基座 + 配置增量（去重，硬禁/主人专属项剔除）。 */
export function allowedToolNames(extra: readonly string[]): string[] {
  return [...new Set([...BASELINE_TOOLS, ...extra])]
    .filter((name) => !isForbiddenTool(name) && !isOwnerTool(name))
}

/** 按回合来源计算放行名单：主人发起的回合额外获得提示词自改工具。 */
export function allowedToolNamesForSource(
  base: readonly string[],
  source: OnebotSource | undefined,
  ownerIds: readonly string[],
): string[] {
  if (!isOwnerSource(source, ownerIds)) return [...base]
  return [...new Set([...base, ...OWNER_TOOLS])]
}

/** 本回合的工具面：restricted=false 表示不裁剪、不否决（主人私聊）。 */
export interface TurnToolPolicy {
  restricted: boolean
  allowed: string[]
}

/**
 * 回合工具面策略：主人私聊整回合不受限（allowed 为空且不参与判定），
 * 其余 OneBot 回合按基座 + 配置增量 + 主人专属工具放行。
 */
export function turnToolPolicy(
  base: readonly string[],
  source: OnebotSource | undefined,
  ownerIds: readonly string[],
): TurnToolPolicy {
  if (isOwnerPrivateSource(source, ownerIds)) return { restricted: false, allowed: [] }
  return { restricted: true, allowed: allowedToolNamesForSource(base, source, ownerIds) }
}

/** 工具条目的名字（cos/DSH 两种 schema 形状）。 */
export function toolNameOf<T extends { name?: string; function?: { name?: string } }>(tool: T): string {
  return tool.name ?? tool.function?.name ?? ''
}

/** 可见性过滤（保持原顺序）；非受限回合原样返回。 */
export function filterToolsForTurn<T extends { name?: string; function?: { name?: string } }>(
  tools: readonly T[],
  active: boolean,
  allowed: readonly string[],
): T[] {
  if (!active) return [...tools]
  const allow = new Set(allowed)
  return tools.filter((tool) => allow.has(toolNameOf(tool)))
}

/** 执行否决：受限回合里不在名单的工具给出拒因；放行返回 undefined。 */
export function vetoIfActive(name: string, active: boolean, allowed: readonly string[]): string | undefined {
  if (!active) return undefined
  if (isForbiddenTool(name)) {
    return `当前回合来自外部聊天（OneBot），工具 "${name}" 属于本机控制或高风险类别，永久不可用。可用工具仅限：${allowed.join('、')}。`
  }
  if (allowed.includes(name)) return undefined
  return `当前回合来自外部聊天（OneBot），工具 "${name}" 不可用。可用工具仅限：${allowed.join('、')}。`
}

/** 回合作用域广播（记忆插件据此选择读写命名空间）。 */
export interface TurnScopeEvent {
  active: boolean
  kind?: 'group' | 'private'
  groupId?: string
  userId?: string
  isOwner?: boolean
}

declare module 'cordis' {
  interface Events {
    'onebot/turn-scope'(scope: TurnScopeEvent): void
  }
}
