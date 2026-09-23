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
  return 'proactive'
}
