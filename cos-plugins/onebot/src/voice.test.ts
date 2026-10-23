// 语音出话决策单测：默认 off、显式意图、长度/冷却硬门、auto 抽样、录音段。
import test from 'node:test'
import assert from 'node:assert/strict'

import { decideVoice, recordSegment, voiceCooldownOk, voiceKey, type VoicePolicy } from './voice.ts'

const ask: VoicePolicy = { mode: 'ask', maxChars: 100, rate: 0.15, cooldownMinutes: 10 }
const auto: VoicePolicy = { ...ask, mode: 'auto' }
const off: VoicePolicy = { ...ask, mode: 'off' }

test('默认 off：任何请求都不合成', () => {
  assert.deepEqual(
    decideVoice({ policy: off, requested: true, textLength: 10, cooldownOk: true, roll: 0 }),
    { voice: false, reason: 'off' },
  )
})

test('ask 模式：只有显式 voice:true 才发语音', () => {
  assert.deepEqual(
    decideVoice({ policy: ask, requested: true, textLength: 10, cooldownOk: true, roll: 0.99 }),
    { voice: true, reason: 'asked' },
  )
  assert.deepEqual(
    decideVoice({ policy: ask, requested: undefined, textLength: 10, cooldownOk: true, roll: 0 }),
    { voice: false, reason: 'rate' },
  )
})

test('显式 voice:false 优先于 auto 抽样', () => {
  assert.deepEqual(
    decideVoice({ policy: auto, requested: false, textLength: 10, cooldownOk: true, roll: 0 }),
    { voice: false, reason: 'declined' },
  )
})

test('长度硬门：超 maxChars 一律降级文本', () => {
  assert.deepEqual(
    decideVoice({ policy: ask, requested: true, textLength: 101, cooldownOk: true, roll: 0 }),
    { voice: false, reason: 'too_long' },
  )
  assert.equal(
    decideVoice({ policy: ask, requested: true, textLength: 100, cooldownOk: true, roll: 0 }).voice,
    true,
  )
})

test('冷却硬门：间隔内不发语音', () => {
  assert.deepEqual(
    decideVoice({ policy: ask, requested: true, textLength: 10, cooldownOk: false, roll: 0 }),
    { voice: false, reason: 'cooldown' },
  )
})

test('auto 模式：概率抽样', () => {
  assert.equal(
    decideVoice({ policy: auto, requested: undefined, textLength: 10, cooldownOk: true, roll: 0.1 }).voice,
    true,
  )
  assert.equal(
    decideVoice({ policy: auto, requested: undefined, textLength: 10, cooldownOk: true, roll: 0.9 }).voice,
    false,
  )
})

test('冷却判定：未记录放行，间隔满才放行', () => {
  const now = 1_000_000
  assert.equal(voiceCooldownOk(undefined, now, 10), true)
  assert.equal(voiceCooldownOk(now - 9 * 60_000, now, 10), false)
  assert.equal(voiceCooldownOk(now - 10 * 60_000, now, 10), true)
})

test('录音段：base64:// 形态；冷却键群聊/私聊分开', () => {
  assert.deepEqual(recordSegment('QUJD'), { type: 'record', data: { file: 'base64://QUJD' } })
  assert.equal(voiceKey('group', '123'), 'g:123')
  assert.equal(voiceKey('private', '123'), 'u:123')
})
