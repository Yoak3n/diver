// @diver/backend — 桌宠互动：设置读写 + UI 折叠识别。
//
// 手势门控/组文案/裁决/inject 已迁壳（CompanionPresence + POST /api/inject）。
// 本模块只保留：diver-settings.petInteraction 读写（设置页）与 SSE/历史折叠标签。

import { readDiverSettings } from './session-helpers.ts'

export type InteractionMode = 'off' | 'events' | 'context'

export interface PetInteractionSettings {
  mode: InteractionMode
  quietMs: number
  cooldownMs: number
  maxTriggers: number
  longHoldMs: number
}

export const DEFAULT_PET_INTERACTION: PetInteractionSettings = {
  mode: 'events',
  quietMs: 10_000,
  cooldownMs: 45_000,
  maxTriggers: 1,
  longHoldMs: 3_000,
}

export function readPetInteractionSettings(
  raw: Record<string, unknown> = readDiverSettings(),
): PetInteractionSettings {
  const src = (raw.petInteraction ?? {}) as Partial<PetInteractionSettings>
  const mode: InteractionMode =
    src.mode === 'off' || src.mode === 'events' || src.mode === 'context'
      ? src.mode
      : DEFAULT_PET_INTERACTION.mode
  const num = (v: unknown, fallback: number, min = 1) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback
  return {
    mode,
    quietMs: num(src.quietMs, DEFAULT_PET_INTERACTION.quietMs, 100),
    cooldownMs: num(src.cooldownMs, DEFAULT_PET_INTERACTION.cooldownMs, 100),
    maxTriggers: num(src.maxTriggers, DEFAULT_PET_INTERACTION.maxTriggers, 1),
    longHoldMs: num(src.longHoldMs, DEFAULT_PET_INTERACTION.longHoldMs, 500),
  }
}

/** SSE / 历史里识别互动痕迹（source.kind === 'plugin' && detail === 'pet-interaction'）。 */
export function isInteractionUserMessage(source: unknown): boolean {
  const s = source as { kind?: string; detail?: string } | null | undefined
  return s?.kind === 'plugin' && s?.detail === 'pet-interaction'
}

/** 壳端已裁决注入的 UI 折叠文案；非注入消息返回 null。 */
export function injectUiLabel(source: unknown): string | null {
  const s = source as { kind?: string; detail?: string } | null | undefined
  if (s?.kind !== 'plugin') return null
  switch (s.detail) {
    case 'pet-interaction':
      return '（互动）'
    case 'presence':
      return '（问候）'
    case 'proactive':
      return '（主动）'
    case 'self-prompt-restart':
      return '（重启完成）'
    default:
      return s.detail ? `（${s.detail}）` : '（注入）'
  }
}

/** 壳端注入消息的 UI origin。 */
export function injectOrigin(source: unknown): 'interaction' | 'presence' | 'proactive' | null {
  const s = source as { kind?: string; detail?: string } | null | undefined
  if (s?.kind !== 'plugin') return null
  if (s?.detail === 'pet-interaction') return 'interaction'
  if (s?.detail === 'presence') return 'presence'
  if (s?.detail === 'self-prompt-restart') return 'proactive'
  return 'proactive'
}

/** peer 消息来源（source.kind 'plugin' + detail 'peer:<id>'｜'group:<gid>:<id>'｜'invite:<gid>:<id>'）；
 * 旧形 'group:<id>' 视作全员群。非 peer 返回 null。 */
export function peerSource(
  source: unknown,
): { id: string; kind: 'peer' | 'group' | 'invite'; group?: string } | null {
  const s = source as { kind?: string; detail?: string } | null | undefined
  if (s?.kind !== 'plugin') return null
  const d = s.detail ?? ''
  const split = (rest: string): { gid: string; id: string } | null => {
    const at = rest.indexOf(':')
    return at > 0 ? { gid: rest.slice(0, at), id: rest.slice(at + 1) } : null
  }
  if (d.startsWith('peer:') && d.length > 5) return { id: d.slice(5), kind: 'peer' }
  if (d.startsWith('group:')) {
    const rest = d.slice(6)
    const parts = split(rest)
    return parts !== null
      ? { id: parts.id, kind: 'group', group: parts.gid }
      : { id: rest, kind: 'group', group: 'general' }
  }
  if (d.startsWith('invite:')) {
    const rest = d.slice(7)
    const parts = split(rest)
    return parts !== null
      ? { id: parts.id, kind: 'invite', group: parts.gid }
      : { id: rest, kind: 'invite', group: 'general' }
  }
  return null
}

/** 壳盖章首行（收方模型可见的来源区分）：私聊 / 群发言 / 群邀请 / 群系统事件。 */
export function inboxMarkerLine(
  kind: 'peer' | 'group' | 'invite',
  fromName: string,
  fromId: string,
  groupName: string,
): string {
  if (kind === 'group') {
    return fromId === 'system'
      ? `【群聊「${groupName}」｜系统事件】`
      : `【群聊「${groupName}」｜来自实例 ${fromName}（${fromId}）】`
  }
  if (kind === 'invite') {
    return `【群聊邀请｜「${groupName}」来自实例 ${fromName}（${fromId}）】`
  }
  return `【消息来自实例 ${fromName}（${fromId}）】`
}

/** 剥掉壳盖章首行（「来自实例」/「系统事件」两族），保留正文（空正文回退原文）。 */
export function stripPeerMarker(text: string): string {
  const stripped = text.replace(/^【[^】\n]*(?:来自实例 |系统事件)[^\n]*?】\r?\n?/, '')
  return stripped.trim() !== '' ? stripped : text
}

/** 群聊广播标记首行（后端注入会话；提示「多人在场、不必每条都回」+ 回应渠道）。 */
export function groupMarkerLine(groupName: string): string {
  return `【群聊「${groupName}」｜其他实例也在场，不必每条都回；想说就用 send_to_group 发言（直接回复对方看不到）】`
}

/** 剥掉群聊广播标记首行（UI 显示用；空正文回退原文）。 */
export function stripGroupMarker(text: string): string {
  const stripped = text.replace(/^【群聊[^】]*?】\r?\n?/, '')
  return stripped.trim() !== '' ? stripped : text
}

/** 用户群广播的归属群（source.detail 'group:<gid>'，kind human）；非群返回 null。 */
export function groupTag(source: unknown): string | null {
  const s = source as { detail?: string } | null | undefined
  const d = s?.detail ?? ''
  return d.startsWith('group:') && d.length > 6 ? d.slice(6) : null
}

/** 从群族标记首行取组名（剥章前用）；非群返回 null。 */
export function groupNameFromMarker(text: string): string | null {
  const m = text.match(/^【群聊「([^」]*)」/)
  return m !== null ? m[1] : null
}

/** 是否用户群聊广播消息（标记首行判定；实例群发言由 peerSource 分支先行拦截）。 */
export function isGroupMessage(text: string): boolean {
  return text.startsWith('【群聊')
}
