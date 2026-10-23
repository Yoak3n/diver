// OneBot 11 协议单测：CQ 码解析/转义、段转文本、@/引用/别名检测。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  atsUser,
  escapeCq,
  mentionsAlias,
  parseCq,
  parseEvent,
  repliesTo,
  segmentsToText,
  senderName,
  toSegments,
} from './protocol.ts'

test('CQ 码解析：文本与 at/face 混合', () => {
  const segs = parseCq('[CQ:at,qq=42] 早啊[CQ:face,id=14]')
  assert.deepEqual(segs.map((s) => s.type), ['at', 'text', 'face'])
  assert.equal(segs[0].data.qq, '42')
  assert.equal(segs[1].data.text, ' 早啊')
})

test('CQ 码解析：坏码按原文保留，不丢内容', () => {
  const segs = parseCq('前[CQ:broken 后]')
  assert.equal(segmentsToText(segs), '前[CQ:broken 后]')
})

test('CQ 转义：& [ ] 全部转义（出站防注入）', () => {
  assert.equal(escapeCq('a&b[c]'), 'a&amp;b&#91;c&#93;')
})

test('segmentsToText：媒体与卡片给占位标记', () => {
  const text = segmentsToText([
    { type: 'at', data: { qq: 'all' } },
    { type: 'text', data: { text: '看图' } },
    { type: 'image', data: {} },
    { type: 'record', data: {} },
    { type: 'reply', data: {} },
  ])
  assert.equal(text, '@全体成员看图[图][语音][回复]')
})

test('at 检测：命中 self / @全体；不误判他人', () => {
  const self = [{ type: 'at', data: { qq: '10001' } }]
  assert.equal(atsUser(self, 10001), true)
  assert.equal(atsUser([{ type: 'at', data: { qq: 'all' } }], 10001), true)
  assert.equal(atsUser([{ type: 'at', data: { qq: '20002' } }], 10001), false)
  assert.equal(atsUser([{ type: 'text', data: { text: '@10001' } }], 10001), false)
})

test('引用检测：只认我方消息 id', () => {
  const segs = [{ type: 'reply', data: { id: '777' } }]
  assert.equal(repliesTo(segs, 777), true)
  assert.equal(repliesTo(segs, 888), false)
})

test('别名检测：大小写不敏感子串', () => {
  assert.equal(mentionsAlias('小麦今天在吗', ['麦麦', '小麦']), '小麦')
  assert.equal(mentionsAlias('Hello MaiBot', ['maibot']), 'maibot')
  assert.equal(mentionsAlias('路过', ['麦麦']), undefined)
  assert.equal(mentionsAlias('任意', ['', ' ']), undefined)
})

test('显示名：群名片优先，昵称兜底，最后 QQ', () => {
  assert.equal(senderName({ user_id: 1, card: '阿明', nickname: 'ming' }), '阿明')
  assert.equal(senderName({ user_id: 1, nickname: 'ming' }), 'ming')
  assert.equal(senderName({ user_id: 1 }), '1')
})

test('parseEvent 窄化：认 message/meta，丢其他', () => {
  const group = parseEvent({
    post_type: 'message',
    message_type: 'group',
    self_id: 1,
    time: 2,
    message_id: 3,
    user_id: 4,
    group_id: 5,
    sender: { user_id: 4 },
    message: 'hi',
  })
  assert.equal(group?.post_type, 'message')
  assert.equal(parseEvent({ post_type: 'notice' }), undefined)
  assert.equal(parseEvent(null), undefined)
})

test('toSegments：数组与 CQ 字符串同形归一', () => {
  const arr = toSegments([{ type: 'text', data: { text: 'a' } }])
  assert.deepEqual(arr, [{ type: 'text', data: { text: 'a' } }])
  const cq = toSegments('[CQ:at,qq=1]b')
  assert.equal(cq.length, 2)
  assert.equal(cq[0].type, 'at')
})
