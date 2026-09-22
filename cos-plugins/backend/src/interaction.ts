// @diver/backend — 桌宠互动事件：白名单校验、文案组装、闲时触发 followup。
//
// 壳端（PetApp）POST /api/event 上报语义事件；本模块负责门控、组消息、注入 agent。
// 不走 /api/chat 的 steer 路径：搭话永远只在闲时 followup。

import { createUserMessage } from '@cos/plugin-api'

import type { IdleGate, ProactiveRejectReason } from './idle-gate.ts'
import { DEFAULT_IDLE_GATE, type IdleGateConfig } from './idle-gate.ts'
import { readDiverSettings } from './session-helpers.ts'
import type { WebState } from './state.ts'

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
  quietMs: DEFAULT_IDLE_GATE.quietMs,
  cooldownMs: DEFAULT_IDLE_GATE.cooldownMs,
  maxTriggers: DEFAULT_IDLE_GATE.maxTriggers,
  longHoldMs: 3000,
}

/** 事件 id 白名单（首版：切屏 + 长拖）。 */
export const PET_EVENT_TYPES = [
  'pet.drag.screen_changed',
  'pet.drag.long_hold',
  'pet.drag.dropped_edge',
  'pet.tap.burst',
] as const

export type PetEventType = (typeof PET_EVENT_TYPES)[number]

export interface PetInteractionEvent {
  type: string
  ts?: number
  source?: string
  payload?: Record<string, unknown>
  context?: {
    display?: {
      id?: number | string
      width?: number
      height?: number
      primary?: boolean
    }
    apps?: string[]
  }
}

export type InteractionHandleResult =
  | { accepted: false; reason: ProactiveRejectReason | 'bad_type' | 'bad_body' }
  | { accepted: true; messageId: string; triggered: true }

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

export function idleGateConfigOf(s: PetInteractionSettings): IdleGateConfig {
  return {
    quietMs: s.quietMs,
    cooldownMs: s.cooldownMs,
    maxTriggers: s.maxTriggers,
  }
}

function detailPhrase(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'pet.drag.screen_changed': {
      const from = payload.fromScreen
      const to = payload.toScreen
      const still = payload.dragging === true ? '，目前仍按住未松手' : ''
      return `用户把桌宠从屏幕 ${from} 拖到了屏幕 ${to}${still}。`
    }
    case 'pet.drag.long_hold': {
      const hold = payload.holdMs
      const ms = typeof hold === 'number' ? Math.round(hold) : '较长时间'
      return `用户拖着你的桌宠已经约 ${ms}ms 还没有松手。`
    }
    case 'pet.drag.dropped_edge':
      return `用户把桌宠丢在了屏幕边缘（${payload.edge ?? 'unknown'}）。`
    case 'pet.tap.burst':
      return `用户在短时间内连续点了桌宠 ${payload.count ?? '?'} 次。`
    default:
      return `事件 ${type}：${JSON.stringify(payload)}`
  }
}

function contextLines(ev: PetInteractionEvent, mode: InteractionMode): string {
  const lines: string[] = []
  const d = ev.context?.display
  if (d) {
    const primary = d.primary === true ? '主屏' : '非主屏'
    const size = d.width && d.height ? `${d.width}x${d.height}` : '分辨率未知'
    lines.push(`上下文: 屏幕 ${d.id ?? '?'} 为 ${size}（${primary}）。`)
  }
  if (mode === 'context' && Array.isArray(ev.context?.apps) && ev.context.apps.length > 0) {
    lines.push(`该屏上的应用概览: ${ev.context.apps.join('、')}。`)
  }
  return lines.join('\n')
}

/** 组装注入给模型的文案（中文，便于陪伴角色自然搭话）。 */
export function buildInteractionPrompt(
  ev: PetInteractionEvent,
  mode: InteractionMode,
): string {
  const payload = ev.payload ?? {}
  const displayId = ev.context?.display?.id
  const displayHint =
    displayId !== undefined
      ? `如果你想看看那边有什么，可以对 display ${displayId} 截屏（不要截错屏幕）。`
      : `如果你想看看现场，可以截取对应显示器的画面（注意截对屏幕）。`
  const parts = [
    '[pet-interaction] 用户在你空闲时和你的桌宠互动了。',
    `事件: ${ev.type}`,
    `细节: ${detailPhrase(ev.type, payload)}`,
  ]
  const ctx = contextLines(ev, mode)
  if (ctx) parts.push(ctx)
  parts.push(
    `提示: ${displayHint} 请简短、自然地做出反应，像陪伴搭话，不要像传感器汇报。若无法读图，就基于以上粗略信息简单回应即可。`,
  )
  return parts.join('\n')
}

export interface HandleInteractionDeps {
  state: WebState
  gate: IdleGate
  ensureAgent: () => Promise<import('@cos/plugin-api').Agent>
  isModelConfigured: () => Promise<boolean>
}

export async function handlePetInteractionEvent(
  body: unknown,
  deps: HandleInteractionDeps,
): Promise<InteractionHandleResult> {
  if (!body || typeof body !== 'object') {
    return { accepted: false, reason: 'bad_body' }
  }
  const ev = body as PetInteractionEvent
  const type = String(ev.type ?? '')
  if (!(PET_EVENT_TYPES as readonly string[]).includes(type)) {
    return { accepted: false, reason: 'bad_type' }
  }

  const settings = readPetInteractionSettings()
  if (settings.mode === 'off') {
    return { accepted: false, reason: 'disabled' }
  }

  const claim = deps.gate.tryClaim()
  if (!claim.ok) return { accepted: false, reason: claim.reason }

  if (!(await deps.isModelConfigured())) {
    return { accepted: false, reason: 'disabled' }
  }

  const text = buildInteractionPrompt(ev, settings.mode)
  // kind=plugin + detail：区别于真人消息；SSE/历史按 detail 识别为互动痕迹。
  const msg = createUserMessage(text, { kind: 'plugin', detail: 'pet-interaction' })
  const agent = await deps.ensureAgent()
  agent.followup(msg)

  // followup 唤醒回合：只推进静默计时，不重置 windowTriggers
  //（真人 noteUserChat 才重置；max_triggers 才能生效）
  deps.gate.noteChat()
  return { accepted: true, messageId: String(msg.id), triggered: true }
}

/** SSE / 历史里识别互动痕迹（source.kind === 'plugin' && detail === 'pet-interaction'）。 */
export function isInteractionUserMessage(source: unknown): boolean {
  const s = source as { kind?: string; detail?: string } | null | undefined
  return s?.kind === 'plugin' && s?.detail === 'pet-interaction'
}
