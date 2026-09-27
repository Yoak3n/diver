// history 重建单测：buildHistoryMessages 的群发言落账（group/sent）与
// 收方注入副本的群归属。运行：pnpm --filter @diver/backend test。
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildHistoryMessages, type ReplayEvent } from './history.ts'

test('group/sent 落账重建为群消息：id 取 clientMsgId，归属发送方', () => {
  const events: ReplayEvent[] = [
    {
      type: 'group/sent',
      time: 1000,
      data: {
        text: '行啦行啦，这局我认输。',
        from: { id: 'default', name: '小芊' },
        group: { id: 'general', name: '全员群' },
        clientMsgId: 'gsay-default-123',
      },
    },
  ]
  const msgs = buildHistoryMessages(events)
  assert.equal(msgs.length, 1)
  const m = msgs[0] as Record<string, unknown>
  assert.equal(m.id, 'gsay-default-123', '与收方副本同 id，合并流按 id 去重')
  assert.equal(m.kind, 'user')
  assert.equal(m.content, '行啦行啦，这局我认输。')
  assert.equal(m.origin, 'peer')
  assert.equal(m.from, 'default')
  assert.equal(m.group, true)
  assert.equal(m.groupId, 'general')
  assert.equal(m.groupName, '全员群')
})

test('收方群发言注入副本：剥章 + group 归属（id 随 clientMsgId 透传）', () => {
  const events: ReplayEvent[] = [
    {
      type: 'user/message',
      time: 2000,
      data: {
        id: 'gsay-default-123',
        content: [{ type: 'text', text: '【群聊「全员群」｜来自实例 小芊（default）】\n行啦行啦，这局我认输。' }],
        source: { kind: 'plugin', detail: 'group:general:default' },
      },
    },
  ]
  const msgs = buildHistoryMessages(events)
  assert.equal(msgs.length, 1)
  const m = msgs[0] as Record<string, unknown>
  assert.equal(m.id, 'gsay-default-123')
  assert.equal(m.content, '行啦行啦，这局我认输。', '剥掉壳盖章首行')
  assert.equal(m.origin, 'peer')
  assert.equal(m.from, 'default')
  assert.equal(m.group, true)
  assert.equal(m.groupId, 'general')
})

test('实例间私聊注入：origin peer 但不进群合并流（无 group 标）', () => {
  const events: ReplayEvent[] = [
    {
      type: 'user/message',
      time: 3000,
      data: {
        id: 'peer-1',
        content: [{ type: 'text', text: '【消息来自实例 小贝（beta）】\n悄悄跟你说个事。' }],
        source: { kind: 'plugin', detail: 'peer:beta' },
      },
    },
  ]
  const msgs = buildHistoryMessages(events)
  assert.equal(msgs.length, 1)
  const m = msgs[0] as Record<string, unknown>
  assert.equal(m.group, undefined, '私聊流量不挂 group 标')
  assert.equal(m.groupId, undefined)
})

test('发送方落账与收方副本同池重建不串位：各自独立成条，去重交给合并流', () => {
  const events: ReplayEvent[] = [
    {
      type: 'group/sent',
      time: 1000,
      data: {
        text: '早',
        from: { id: 'default', name: '小芊' },
        group: { id: 'general', name: '全员群' },
        clientMsgId: 'gsay-default-1',
      },
    },
    {
      type: 'user/message',
      time: 2000,
      data: {
        id: 'gsay-default-1',
        content: [{ type: 'text', text: '【群聊「全员群」｜来自实例 小芊（default）】\n早' }],
        source: { kind: 'plugin', detail: 'group:general:default' },
      },
    },
  ]
  // 同一个池子里同时出现落账与副本属异常路径（两副本分属不同实例池），
  // 重建层不去重——断言两条都带同 id，去重由前端合并流按 id 收口。
  const msgs = buildHistoryMessages(events)
  assert.equal(msgs.length, 2)
  assert.deepEqual(msgs.map((m) => (m as Record<string, unknown>).id), ['gsay-default-1', 'gsay-default-1'])
})
