// @diver/onebot — 语音出话决策（纯函数）。
//
// 默认 off（配了才开）：mode=off 时任何 voice 请求都不合成。
// mode=ask 只在模型显式 voice:true 时发语音；mode=auto 额外按概率自动。
// 硬门：长度（QQ 语音 60s 上限的保守对应）、冷却（语音计费更贵）。
//
// 合成文本必须是**已遮蔽**的版本（调用方在 maskOutbound 之后调用）；
// 语音只是同一段文字的另一种载体，不走第二条内容通道。

import type { Segment } from './protocol.ts'

export type VoiceMode = 'off' | 'ask' | 'auto'

export interface VoicePolicy {
  mode: VoiceMode
  /** 单条语音最大字符数（超出降级文本）。 */
  maxChars: number
  /** auto 模式的抽样概率。 */
  rate: number
  /** 同一会话两次语音的最小间隔（分钟）。 */
  cooldownMinutes: number
}

/** 语音决策原因（工具结果与日志用）。 */
export type VoiceReason =
  | 'off'
  | 'declined'
  | 'too_long'
  | 'cooldown'
  | 'asked'
  | 'auto'
  | 'rate'

export interface VoiceDecision {
  voice: boolean
  reason: VoiceReason
}

/**
 * 语音决策：模式 → 显式拒绝 → 长度 → 冷却 → 意图/抽样。
 * `requested`  undefined = 模型未表态；true/false = 显式要求。
 * `roll` 由调用方注入（可测）。
 */
export function decideVoice(input: {
  policy: VoicePolicy
  requested: boolean | undefined
  textLength: number
  cooldownOk: boolean
  roll: number
}): VoiceDecision {
  const { policy, requested, textLength, cooldownOk, roll } = input
  if (policy.mode === 'off') return { voice: false, reason: 'off' }
  if (requested === false) return { voice: false, reason: 'declined' }
  if (textLength > policy.maxChars) return { voice: false, reason: 'too_long' }
  if (!cooldownOk) return { voice: false, reason: 'cooldown' }
  if (requested === true) return { voice: true, reason: 'asked' }
  if (policy.mode === 'auto' && roll < policy.rate) return { voice: true, reason: 'auto' }
  return { voice: false, reason: 'rate' }
}

/** 冷却判定（首次/未记录放行）。 */
export function voiceCooldownOk(
  lastAt: number | undefined,
  now: number,
  cooldownMinutes: number,
): boolean {
  if (lastAt === undefined) return true
  return now - lastAt >= cooldownMinutes * 60_000
}

/** OneBot 语音段：base64 交给实现侧转 silk（NapCat/Lagrange 通用形态）。 */
export function recordSegment(base64: string): Segment {
  return { type: 'record', data: { file: `base64://${base64}` } }
}

/** 语音冷却键：群与私聊分开计。 */
export function voiceKey(kind: 'group' | 'private', id: string): string {
  return `${kind === 'group' ? 'g' : 'u'}:${id}`
}
