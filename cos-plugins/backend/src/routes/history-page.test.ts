// history-page 单测：/history 分页切片（rounds 尾窗 + before 懒加载锚点）。
// 运行：pnpm --filter @diver/backend test（node --import tsx --test）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { chunkBefore, parseHistoryQuery, roundTail, ROUNDS_TAIL_CAP } from './history-page.ts'

interface Row {
  kind?: string
  id?: string
  time?: number
}

/** 便捷构造：n 轮对话，每轮 user + assistant，id 递增。 */
function rounds(n: number, startId = 0): Row[] {
  const out: Row[] = []
  for (let i = 0; i < n; i += 1) {
    out.push({ kind: 'user', id: `u${startId + i}`, time: startId + i * 10 })
    out.push({ kind: 'assistant', id: `a${startId + i}`, time: startId + i * 10 + 1 })
  }
  return out
}

test('roundTail：取最近 N 轮（user 消息为边界，含后续 assistant）', () => {
  const msgs = [...rounds(2), ...rounds(3, 10)]
  const page = roundTail(msgs, 2)
  assert.deepEqual(
    page.list.map((m) => m.id),
    ['u11', 'a11', 'u12', 'a12'],
  )
  assert.equal(page.hasMore, true)
})

test('roundTail：轮次边界从 user 消息起，更早的 system 归前文', () => {
  const msgs: Row[] = [
    { kind: 'system', id: 's0', time: 0 },
    { kind: 'user', id: 'u0', time: 1 },
    { kind: 'assistant', id: 'a0', time: 2 },
    { kind: 'user', id: 'u1', time: 3 },
    { kind: 'assistant', id: 'a1', time: 4 },
  ]
  const page = roundTail(msgs, 2)
  assert.deepEqual(
    page.list.map((m) => m.id),
    ['u0', 'a0', 'u1', 'a1'],
  )
  assert.equal(page.hasMore, true)
})

test('roundTail：轮次不足时返回全部', () => {
  const msgs = rounds(2)
  const page = roundTail(msgs, 5)
  assert.equal(page.list.length, 4)
  assert.equal(page.hasMore, false)
})

test('roundTail：超长 turn 触发硬上限兜底', () => {
  const msgs: Row[] = [
    { kind: 'user', id: 'u0', time: 0 },
    ...Array.from({ length: ROUNDS_TAIL_CAP + 30 }, (_, i) => ({
      kind: 'assistant' as const,
      id: `a${i}`,
      time: i + 1,
    })),
  ]
  const page = roundTail(msgs, 2)
  assert.equal(page.list.length, ROUNDS_TAIL_CAP)
  assert.equal(page.hasMore, true)
})

test('chunkBefore：按 id 锚点向前取 limit 条', () => {
  const msgs = rounds(10)
  const page = chunkBefore(msgs, { before: 'u7', limit: 4 })
  assert.deepEqual(
    page.list.map((m) => m.id),
    ['u5', 'a5', 'u6', 'a6'],
  )
  assert.equal(page.hasMore, true)
})

test('chunkBefore：锚点在头部返回空页', () => {
  const msgs = rounds(3)
  assert.deepEqual(chunkBefore(msgs, { before: 'u0', limit: 10 }), { list: [], hasMore: false })
})

test('chunkBefore：id 未命中回退 beforeTime（严格早于锚点时间）', () => {
  const msgs = rounds(5)
  const page = chunkBefore(msgs, { before: 'ghost', beforeTime: msgs[3].time, limit: 2 })
  assert.deepEqual(
    page.list.map((m) => m.id),
    ['a0', 'u1'],
  )
  assert.equal(page.hasMore, true)
})

test('chunkBefore：完全定位失败返回空页', () => {
  const msgs = rounds(3)
  assert.deepEqual(chunkBefore(msgs, { before: 'ghost', limit: 4 }), { list: [], hasMore: false })
})

test('parseHistoryQuery：合法参数收窄、非法值忽略', () => {
  assert.deepEqual(parseHistoryQuery('/api/history?rounds=2&limit=30'), {
    rounds: 2,
    limit: 30,
  })
  assert.deepEqual(parseHistoryQuery('/api/history?rounds=-1&limit=999&before='), { limit: 200 })
  const q = parseHistoryQuery('/api/history?rounds=99&before=u1&beforeTime=123.9')
  assert.deepEqual(q, { rounds: 20, before: 'u1', beforeTime: 123, limit: 60 })
  assert.deepEqual(parseHistoryQuery(undefined), { limit: 60 })
})
