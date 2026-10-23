// 发送熔断单测：连续失败熔断、成功清账、愈合窗自动恢复。
import test from 'node:test'
import assert from 'node:assert/strict'

import { BREAKER_HEAL_MS, SEND_FAIL_LIMIT, SendBreaker, breakerErrorMessage } from './send-breaker.ts'

test('连续失败达上限进入熔断，成功一次清账', () => {
  const breaker = new SendBreaker()
  const t0 = 1_000_000
  for (let i = 0; i < SEND_FAIL_LIMIT; i += 1) {
    assert.equal(breaker.blocked(t0), false)
    breaker.recordFail(t0)
  }
  assert.equal(breaker.blocked(t0), true)
  assert.equal(breaker.failCount(), SEND_FAIL_LIMIT)
  breaker.recordOk()
  assert.equal(breaker.blocked(t0), false)
  assert.equal(breaker.failCount(), 0)
})

test('熔断在愈合窗后自动恢复（风控通常短暂）', () => {
  const breaker = new SendBreaker()
  const t0 = 2_000_000
  for (let i = 0; i < SEND_FAIL_LIMIT; i += 1) breaker.recordFail(t0)
  assert.equal(breaker.blocked(t0 + BREAKER_HEAL_MS - 1), true)
  assert.equal(breaker.blocked(t0 + BREAKER_HEAL_MS), false)
})

test('未达上限的零星失败不熔断', () => {
  const breaker = new SendBreaker()
  breaker.recordFail(1)
  breaker.recordFail(2)
  assert.equal(breaker.blocked(3), false)
})

test('熔断文案带连续失败次数', () => {
  assert.match(breakerErrorMessage(SEND_FAIL_LIMIT), new RegExp(`失败 ${SEND_FAIL_LIMIT} 次`))
  assert.match(breakerErrorMessage(SEND_FAIL_LIMIT), /结束本回合/)
})
