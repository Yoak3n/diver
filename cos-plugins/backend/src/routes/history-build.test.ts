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

test('tool/result 带图：工具产出的图片透传到工具记录（上限 4 张）', () => {
  const img = (data: string) => ({ mime: 'image/jpeg', data })
  const events: ReplayEvent[] = [
    {
      type: 'assistant/message',
      time: 1000,
      data: {
        turn: 1,
        step: 0,
        message: { id: 'a1', content: [{ type: 'tool-call', id: 'c1', name: 'screenshot', arguments: '{}' }] },
      },
    },
    {
      type: 'tool/result',
      time: 1100,
      data: {
        turn: 1,
        step: 0,
        callId: 'c1',
        message: {
          content: '已截取主屏',
          isError: false,
          images: [img('aGk='), img('eHg='), img('MQ=='), img('Mg=='), img('Mw==')],
        },
      },
    },
  ]
  const msgs = buildHistoryMessages(events)
  const tools = (msgs[0] as { tools?: Array<Record<string, unknown>> }).tools
  assert.equal(tools?.length, 1)
  assert.equal(tools![0]!.status, 'result')
  assert.equal(tools![0]!.args, '{}', '结果回填不丢调用参数')
  const images = tools![0]!.images as Array<{ mime: string; data: string }>
  assert.equal(images.length, 4, '第 5 张截断')
  assert.equal(images[0]!.data, 'aGk=')
})

test('tool-call 块参数：透传给 UI 并限幅（超 4000 字截断加省略号）', () => {
  const long = 'x'.repeat(5000)
  const events: ReplayEvent[] = [
    {
      type: 'assistant/message',
      time: 1000,
      data: {
        turn: 1,
        step: 0,
        message: {
          id: 'a1',
          content: [{ type: 'tool-call', id: 'c1', name: 'revise_prompt', arguments: JSON.stringify({ content: long }) }],
        },
      },
    },
  ]
  const tools = (buildHistoryMessages(events)[0] as { tools?: Array<Record<string, unknown>> }).tools
  const args = String(tools![0]!.args)
  assert.ok(args.startsWith('{"content":"xxx'), '参数透传（原始 JSON 串）')
  assert.equal(args.length, 4001, '4000 字 + 省略号')
  assert.ok(args.endsWith('…'))
})
