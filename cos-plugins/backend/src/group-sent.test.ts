// 群发言落账（产品自有存储）单测：读写往返、坏行容错、历史合并（排序/去重/稳定性）。
// 运行：pnpm --filter @diver/backend test。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendGroupSent,
  groupSentMessage,
  groupSentPath,
  mergeGroupSent,
  readGroupSent,
  type GroupSentRecord,
} from './group-sent.ts'

function record(over: Partial<GroupSentRecord> = {}): GroupSentRecord {
  return {
    text: '早',
    from: { id: 'default', name: '小芊' },
    group: { id: 'general', name: '全员群' },
    clientMsgId: 'gsay-default-1',
    time: 1000,
    ...over,
  }
}

test('落账文件在产品家园下（与会话日志同家园、不同文件）', () => {
  assert.equal(groupSentPath('C:\\home'), join('C:\\home', 'group-sent.jsonl'))
})

test('读写往返：追加即可读回，字段保真', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gsay-'))
  const file = join(dir, 'group-sent.jsonl')
  assert.deepEqual(readGroupSent(file), [], '文件不存在返回空')
  appendGroupSent(file, record())
  appendGroupSent(file, record({ clientMsgId: 'gsay-default-2', text: '在', time: 2000 }))
  const all = readGroupSent(file)
  assert.equal(all.length, 2)
  assert.deepEqual(all[0], record())
  assert.equal(all[1].text, '在')
  assert.equal(all[1].time, 2000)
})

test('坏行与残缺记录跳过，不阻断历史重建', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gsay-'))
  const file = join(dir, 'group-sent.jsonl')
  writeFileSync(file, [
    '{ 这不是 JSON',
    JSON.stringify({ text: '', clientMsgId: 'x' }),
    JSON.stringify({ text: '无 id' }),
    JSON.stringify(record({ clientMsgId: 'good' })),
    '',
  ].join('\n'))
  const all = readGroupSent(file)
  assert.equal(all.length, 1)
  assert.equal(all[0].clientMsgId, 'good')
})

test('落账 → 历史消息：id 取 clientMsgId，group 归属与群名齐备', () => {
  const m = groupSentMessage(record())
  assert.equal(m.id, 'gsay-default-1', '与收方副本同 id，合并流按 id 去重')
  assert.equal(m.kind, 'user')
  assert.equal(m.content, '早')
  assert.equal(m.origin, 'peer')
  assert.equal(m.from, 'default')
  assert.equal(m.group, true)
  assert.equal(m.groupId, 'general')
  assert.equal(m.groupName, '全员群')
})

test('合并：按时间升序插入会话日志消息之间', () => {
  const messages: Array<Record<string, unknown>> = [
    { id: 'u1', time: 1000 },
    { id: 'a1', time: 3000 },
  ]
  const merged = mergeGroupSent(messages, [record({ clientMsgId: 'g1', time: 2000 })])
  assert.deepEqual(merged.map((m) => m.id), ['u1', 'g1', 'a1'])
})

test('合并：同刻稳定——会话日志消息在前', () => {
  const messages: Array<Record<string, unknown>> = [{ id: 'u1', time: 2000 }]
  const merged = mergeGroupSent(messages, [record({ clientMsgId: 'g1', time: 2000 })])
  assert.deepEqual(merged.map((m) => m.id), ['u1', 'g1'])
})

test('合并：会话日志已有同 id 时跳过落账副本', () => {
  const messages: Array<Record<string, unknown>> = [{ id: 'gsay-default-1', time: 1000 }]
  const merged = mergeGroupSent(messages, [record()])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'gsay-default-1')
})

test('合并：无落账时原样返回', () => {
  const messages: Array<Record<string, unknown>> = [{ id: 'u1', time: 1000 }]
  assert.equal(mergeGroupSent(messages, []), messages)
})
