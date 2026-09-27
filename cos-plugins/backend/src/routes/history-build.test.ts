// history 重建单测：收方注入副本的群归属与私聊分流。
// 发送方落账（群发言）已移出会话日志与 codec → 见 ../group-sent.test.ts。
// 运行：pnpm --filter @diver/backend test。
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildHistoryMessages, type ReplayEvent } from './history.ts'

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
