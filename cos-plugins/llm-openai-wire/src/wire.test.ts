// llm-openai-wire 单测：工具序列约束（translate 注入时机 + sanitize 兜底）。
// 运行：pnpm --filter @diver/llm-openai-wire test（node --import tsx --test）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseSseData, sanitizeToolSequence, translate } from './index.ts'
import type { ChatMessage } from './index.ts'
import type { ModelMessage } from '@cos/plugin-api'

/** 便捷构造：assistant 消息（可带 tool-call 块）。 */
function assistant(opts: { text?: string; calls?: Array<{ id: string; name: string }> }): ModelMessage {
  return {
    role: 'assistant',
    content: [
      ...(opts.text === undefined ? [] : [{ type: 'text' as const, text: opts.text }]),
      ...(opts.calls ?? []).map((c) => ({ type: 'tool-call' as const, id: c.id, name: c.name, arguments: '{}' })),
    ],
  }
}

function tool(opts: { callId: string; text?: string; image?: boolean }): ModelMessage {
  return {
    role: 'tool',
    callId: opts.callId,
    content: [
      { type: 'text' as const, text: opts.text ?? 'ok' },
      ...(opts.image === true ? [{ type: 'image' as const, mime: 'image/jpeg', data: 'QUJD', name: 'shot' }] : []),
    ],
  }
}

function user(text: string): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

/** 断言 wire 满足硬约束：assistant(tool_calls) 后连续跟满全部 tool 结果。 */
function assertSequenceValid(wire: ReturnType<typeof translate>): void {
  let pending: string[] = []
  for (const m of wire) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      assert.equal(pending.length, 0, `前一个 run 未闭合就来了新 assistant: ${pending.join(',')}`)
      pending = m.tool_calls.map((c) => c.id)
    } else if (m.role === 'tool') {
      assert.ok(pending.length > 0, `孤儿 tool 消息 (call ${m.tool_call_id})`)
      assert.ok(pending.includes(m.tool_call_id ?? ''), `tool call_id 不匹配: ${m.tool_call_id}`)
      pending = pending.filter((x) => x !== m.tool_call_id)
    } else if (pending.length > 0) {
      assert.fail(`tool run 被 ${m.role} 消息打断,还缺: ${pending.join(',')}`)
    }
  }
  assert.equal(pending.length, 0, `历史结尾悬空 tool_calls: ${pending.join(',')}`)
}

test('事故回归:多调用轮次中带图结果在前,图片 user 消息不得插进两条 tool 中间', () => {
  const history: ModelMessage[] = [
    user('看看屏幕'),
    assistant({ calls: [{ id: 'call_00_shot', name: 'screenshot' }, { id: 'call_01_sh', name: 'sh' }] }),
    tool({ callId: 'call_00_shot', image: true }),
    tool({ callId: 'call_01_sh' }),
    user('继续'),
  ]
  const wire = translate(history, 'sys')
  assertSequenceValid(wire)
  const roles = wire.map((m) => (m.role === 'user' ? 'user' : m.role))
  // 关键断言:两条 tool 连续,图片 user 消息在 run 闭合之后
  const shotIdx = wire.findIndex((m) => m.tool_call_id === 'call_00_shot')
  const shIdx = wire.findIndex((m) => m.tool_call_id === 'call_01_sh')
  assert.equal(shotIdx + 1, shIdx, '两条 tool 结果必须相邻')
  const imgUserIdx = wire.findIndex((m) => m.role === 'user' && Array.isArray(m.content))
  assert.ok(imgUserIdx > shIdx, '图片 user 消息必须在全部 tool 结果之后')
  assert.deepEqual(roles.slice(-2), ['user', 'user'], '图片注入 + 真实 user')
})

test('单调用带图结果:图片 user 消息紧随该条 tool(行为保持)', () => {
  const wire = translate([
    assistant({ calls: [{ id: 'c1', name: 'screenshot' }] }),
    tool({ callId: 'c1', image: true }),
  ])
  assertSequenceValid(wire)
  assert.equal(wire.length, 3)
  assert.equal(wire[1].role, 'tool')
  assert.equal(wire[2].role, 'user')
  const parts = wire[2].content as Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
  assert.equal(parts[0].type, 'image_url')
  assert.match(parts[1].type === 'text' ? parts[1].text : '', /tool result image/)
})

test('同一轮多个带图结果:合并为一条 user 消息,置于 run 闭合后', () => {
  const wire = translate([
    assistant({ calls: [{ id: 'a', name: 'screenshot' }, { id: 'b', name: 'shot2' }] }),
    tool({ callId: 'a', image: true }),
    tool({ callId: 'b', image: true }),
  ])
  assertSequenceValid(wire)
  const users = wire.filter((m) => m.role === 'user')
  assert.equal(users.length, 1, '两张图合并为一条 user 消息')
})

test('兜底:结果全部缺失(调用被中断)→ 补占位 tool 结果', () => {
  const wire = sanitizeToolSequence([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'sh', arguments: '' } }] },
    { role: 'user', content: '继续' },
  ])
  assertSequenceValid(wire)
  const synth = wire.find((m) => m.role === 'tool' && m.tool_call_id === 'x')
  assert.ok(synth, '必须补出占位 tool 消息')
  assert.match(String(synth.content), /interrupted/)
})

test('兜底:结果部分缺失 → 只补缺的那个,真实结果原位保留', () => {
  const wire = sanitizeToolSequence([
    { role: 'assistant', content: '', tool_calls: [
      { id: 'have', type: 'function', function: { name: 'sh', arguments: '' } },
      { id: 'lost', type: 'function', function: { name: 'read', arguments: '' } },
    ] },
    { role: 'tool', tool_call_id: 'have', content: 'ok' },
  ])
  assertSequenceValid(wire)
  const idx = wire.findIndex((m) => m.role === 'tool' && m.tool_call_id === 'have')
  assert.equal(wire[idx + 1]?.tool_call_id, 'lost', '占位结果紧跟真实结果')
})

test('兜底:孤儿 tool 结果转 user 消息保留信息', () => {
  const wire = sanitizeToolSequence([
    { role: 'tool', tool_call_id: 'ghost', content: '有用数据' },
    { role: 'user', content: 'hi' },
  ])
  assertSequenceValid(wire)
  const note = wire[0]
  assert.equal(note.role, 'user')
  assert.match(String(note.content), /orphan tool result/)
  assert.match(String(note.content), /有用数据/)
})

test('兜底:打断者(user 消息插在两条结果中间)扣下并在 run 闭合后放行', () => {
  const wire = sanitizeToolSequence([
    { role: 'assistant', content: '', tool_calls: [
      { id: 'a', type: 'function', function: { name: 'sh', arguments: '' } },
      { id: 'b', type: 'function', function: { name: 'sh', arguments: '' } },
    ] },
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'user', content: '插队消息' },
    { role: 'tool', tool_call_id: 'b', content: 'B' },
  ])
  assertSequenceValid(wire)
  const roles = wire.map((m) => m.role)
  assert.deepEqual(roles, ['assistant', 'tool', 'tool', 'user'], 'tool 连续,user 放到闭合后')
})

test('兜底:合法序列原样通过(不重排、不丢消息)', () => {
  const good: ChatMessage[] = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'u1' },
    { role: 'assistant' as const, content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'sh', arguments: '' } }] },
    { role: 'tool' as const, tool_call_id: 'a', content: 'r' },
    { role: 'assistant' as const, content: 'done' },
    { role: 'user' as const, content: 'u2' },
  ]
  assert.deepEqual(sanitizeToolSequence(good), good)
})

test('兜底:历史结尾悬空 tool_calls 也要补占位', () => {
  const wire = sanitizeToolSequence([
    { role: 'assistant', content: '', tool_calls: [{ id: 'tail', type: 'function', function: { name: 'sh', arguments: '' } }] },
  ])
  assertSequenceValid(wire)
  assert.equal(wire.length, 2)
  assert.equal(wire[1].tool_call_id, 'tail')
})

test('parseSseData:空载荷、[DONE]、正常 JSON', () => {
  assert.equal(parseSseData('data:'), null)
  assert.equal(parseSseData('data: [DONE]'), null)
  assert.equal(parseSseData(': keep-alive'), null)
  assert.deepEqual(parseSseData('data: {"a":1}'), { a: 1 })
})
