// 自己发言记账单测：展示文本三态、缓冲行形状、clientMsgId 空间、
// 群/私聊两路落盘（群发额外落 group-sent.jsonl，channel=onebot）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { groupBufferPath, privateBufferPath, readMessages } from './buffer-store.ts'
import {
  appendGroupLedger,
  createSelfRecorder,
  selfBufferMessage,
  sentClientMsgId,
  sentDisplayText,
  type SelfSendInput,
} from './self-ledger.ts'

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'onebot-self-ledger-'))
}

function send(partial: Partial<SelfSendInput> = {}): SelfSendInput {
  return { kind: 'group', peerId: '123', text: '你好', voice: false, hasImage: false, messageId: 456, ...partial }
}

test('sentDisplayText：纯图/语音/普通三态（语音+图记语音）', () => {
  assert.equal(sentDisplayText('', false, true), '[图]')
  assert.equal(sentDisplayText('你好', true, false), '[语音] 你好')
  assert.equal(sentDisplayText('你好', false, false), '你好')
  assert.equal(sentDisplayText('看这张图', true, true), '[语音] 看这张图')
})

test('selfBufferMessage：名字固定「我」、atMe 恒 false、纯图兜底占位', () => {
  assert.deepEqual(
    selfBufferMessage(send({ text: '', hasImage: true, messageId: 9 }), 10086, 1234),
    { time: 1234, userId: '10086', name: '我', text: '[图]', messageId: 9, atMe: false },
  )
})

test('sentClientMsgId：有 id 用 id，无 id 用落账时刻兜底', () => {
  assert.equal(sentClientMsgId('123', 456, 789), 'ob-s-g123-456')
  assert.equal(sentClientMsgId('123', 0, 789), 'ob-s-g123-t789')
})

test('appendGroupLedger：记录与 backend GroupSentRecord 同形 + channel 标记', () => {
  const home = tmpHome()
  try {
    appendGroupLedger(send(), { id: 10086, name: '纪' }, '测试群', home)
    const [line] = readFileSync(join(home, 'group-sent.jsonl'), 'utf8').trim().split('\n')
    const record = JSON.parse(line) as Record<string, unknown>
    assert.equal(record.text, '你好')
    assert.deepEqual(record.from, { id: '10086', name: '纪' })
    assert.deepEqual(record.group, { id: '123', name: '测试群' })
    assert.match(String(record.clientMsgId), /^ob-s-g123-456$/)
    assert.equal(typeof record.time, 'number')
    assert.equal(record.channel, 'onebot')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('createSelfRecorder：群发进缓冲并落账，私聊只进缓冲', async () => {
  const home = tmpHome()
  try {
    const record = createSelfRecorder({
      selfIdentity: () => ({ id: 10086, name: '纪' }),
      groupNameOf: async (id) => `群名${id}`,
      home,
    })
    await record(send())
    await record(send({ kind: 'private', peerId: '777', text: '', hasImage: true, messageId: 0 }))

    const group = readMessages(groupBufferPath('123', home))
    assert.equal(group.length, 1)
    assert.equal(group[0]?.name, '我')
    assert.equal(group[0]?.text, '你好')

    const priv = readMessages(privateBufferPath('777', home))
    assert.equal(priv.length, 1)
    assert.equal(priv[0]?.text, '[图]')

    const ledger = readFileSync(join(home, 'group-sent.jsonl'), 'utf8').trim().split('\n')
    assert.equal(ledger.length, 1)
    const rec = JSON.parse(ledger[0]) as Record<string, unknown>
    assert.deepEqual(rec.group, { id: '123', name: '群名123' })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('createSelfRecorder：群名解析失败落兜底名，绝不抛出', async () => {
  const home = tmpHome()
  try {
    const record = createSelfRecorder({
      selfIdentity: () => ({ id: 1, name: 'x' }),
      groupNameOf: async () => {
        throw new Error('rpc down')
      },
      home,
    })
    await record(send({ peerId: '9', messageId: 1 }))
    const rec = JSON.parse(readFileSync(join(home, 'group-sent.jsonl'), 'utf8')) as Record<string, unknown>
    assert.deepEqual(rec.group, { id: '9', name: '群9' })
    // 缓冲仍然落了（时间线优先于署名）
    assert.equal(readMessages(groupBufferPath('9', home)).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
