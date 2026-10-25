// 触发策略单测：档位必回/抽样、冷却、沉默退避与提前重估、深夜降档。
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from './config.ts'
import {
  deliveryTier,
  evaluateGate,
  evaluatePrivateGate,
  evaluateTrigger,
  newGateState,
  newPrivateGate,
  nextBackoffMs,
  plainRateForHour,
  recordTurnOutcome,
} from './trigger.ts'

const cfg = resolveConfig({ rateMention: 0.9, rateQuoted: 0.8, ratePlain: 0.05, cooldownMinutes: 15 })

test('被 @ 与私聊必回，不吃抽样', () => {
  assert.equal(evaluateTrigger({ kind: 'at', windowCount: 0 }, cfg, 0.999).fire, true)
  assert.equal(evaluateTrigger({ kind: 'private', windowCount: 0 }, cfg, 0.999).fire, true)
})

test('提及/引用/普通按概率抽样', () => {
  assert.equal(evaluateTrigger({ kind: 'mention', windowCount: 0 }, cfg, 0.5).fire, true)
  assert.equal(evaluateTrigger({ kind: 'mention', windowCount: 0 }, cfg, 0.95).fire, false)
  assert.equal(evaluateTrigger({ kind: 'quoted', windowCount: 0 }, cfg, 0.79).fire, true)
  assert.equal(evaluateTrigger({ kind: 'plain', windowCount: 0 }, cfg, 0.01).fire, true)
  assert.equal(evaluateTrigger({ kind: 'plain', windowCount: 0 }, cfg, 0.5).fire, false)
})

test('冷却：15 分钟内第二次普通档被拒', () => {
  const state = newGateState()
  const t0 = 1_000_000
  assert.equal(evaluateGate(state, cfg, t0).open, true)
  assert.deepEqual(evaluateGate(state, cfg, t0 + 60_000), { open: false, reason: 'cooldown' })
  // 冷却结束放行
  assert.equal(evaluateGate(state, cfg, t0 + 15 * 60_000).open, true)
})

test('退避：连续沉默 2 次后 15s 起指数拉长，300s 封顶', () => {
  assert.equal(nextBackoffMs(0), 0)
  assert.equal(nextBackoffMs(1), 0)
  assert.equal(nextBackoffMs(2), 15_000)
  assert.equal(nextBackoffMs(3), 30_000)
  assert.equal(nextBackoffMs(10), 300_000)
})

test('回合结局记账：发言清账，沉默计连击并设退避', () => {
  const state = newGateState()
  const t0 = 2_000_000
  recordTurnOutcome(state, false, t0)
  assert.equal(state.silentStreak, 1)
  assert.equal(state.backoffUntil, 0)
  recordTurnOutcome(state, false, t0)
  assert.equal(state.silentStreak, 2)
  assert.equal(state.backoffUntil, t0 + 15_000)
  recordTurnOutcome(state, true, t0)
  assert.equal(state.silentStreak, 0)
  assert.equal(state.backoffUntil, 0)
})

test('退避等待期：未攒够 6 条继续拒，攒够提前重估', () => {
  const state = newGateState()
  const t0 = 3_000_000
  state.lastFireAt = t0 - 20 * 60_000 // 冷却已过
  state.backoffUntil = t0 + 300_000
  // 前 5 条：继续退避（第 6 条才满足提前重估门槛）
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(evaluateGate(state, cfg, t0), { open: false, reason: 'backoff' })
  }
  assert.equal(evaluateGate(state, cfg, t0).open, true)
})

test('深夜降档：9 点前概率 ×0.8，白天原样', () => {
  assert.equal(plainRateForHour(0.5, new Date(2026, 0, 1, 3, 0)), 0.4)
  assert.equal(plainRateForHour(0.5, new Date(2026, 0, 1, 12, 0)), 0.5)
})

test('私聊限频：窗口内超额静默，窗口滚动恢复，0 不限制', () => {
  const gate = newPrivateGate()
  const t0 = 4_000_000
  for (let i = 0; i < 30; i += 1) {
    assert.equal(evaluatePrivateGate(gate, 30, t0).open, true)
  }
  assert.deepEqual(evaluatePrivateGate(gate, 30, t0 + 1_000), { open: false, reason: 'flood' })
  // 固定窗口：满 1 小时重开
  assert.equal(evaluatePrivateGate(gate, 30, t0 + 3_600_000).open, true)
  const unlimited = newPrivateGate()
  for (let i = 0; i < 100; i += 1) {
    assert.equal(evaluatePrivateGate(unlimited, 0, t0).open, true)
  }
})

test('投递档位：可插话（忙且来源域一致）时触发类 steer，plain 与其余一律 followup', () => {
  for (const kind of ['at', 'mention', 'quoted', 'private'] as const) {
    assert.equal(deliveryTier(kind, true), 'steer')
  }
  assert.equal(deliveryTier('plain', true), 'followup')
  for (const kind of ['at', 'mention', 'quoted', 'plain', 'private'] as const) {
    assert.equal(deliveryTier(kind, false), 'followup')
  }
})
