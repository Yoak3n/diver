// 事件时间戳（盖章/剥章）单测：格式补零、幂等替换、剥章回退。
// 运行：pnpm --filter @diver/backend test。
import test from 'node:test'
import assert from 'node:assert/strict'

import { formatEventStamp, stampEventText, stripEventStamp } from './interaction.ts'

test('formatEventStamp：本地时区 YYYY-MM-DD HH:mm 补零', () => {
  const t = new Date(2026, 8, 8, 7, 5).getTime()
  assert.equal(formatEventStamp(t), '2026-09-08 07:05')
})

test('stampEventText：盖在首部，stripEventStamp 可回退', () => {
  const t = new Date(2026, 8, 28, 11, 31).getTime()
  const stamped = stampEventText('[presence] 早上好', t)
  assert.equal(stamped, '[2026-09-28 11:31] [presence] 早上好')
  assert.equal(stripEventStamp(stamped), '[presence] 早上好')
})

test('stampEventText：重复盖章替换旧戳（幂等）', () => {
  const t1 = new Date(2026, 8, 28, 11, 31).getTime()
  const t2 = new Date(2026, 8, 28, 12, 0).getTime()
  const once = stampEventText('用户点了桌宠', t1)
  assert.equal(stampEventText(once, t2), '[2026-09-28 12:00] 用户点了桌宠')
})

test('stripEventStamp：无戳文本原样返回，标记章不受影响', () => {
  assert.equal(stripEventStamp('[presence] 早上好'), '[presence] 早上好')
  assert.equal(stripEventStamp('[pet-interaction] 用户点了桌宠'), '[pet-interaction] 用户点了桌宠')
})
