// 窗口与唤醒消息单测：三限裁剪、渲染、首行来源章与结尾指令。
import test from 'node:test'
import assert from 'node:assert/strict'

import { formatWake, renderWindow, selectWindow, type BufferedMessage } from './context.ts'

function msg(over: Partial<BufferedMessage> = {}): BufferedMessage {
  return {
    time: Date.now(),
    userId: '1',
    name: '阿明',
    text: '早',
    messageId: 1,
    atMe: false,
    ...over,
  }
}

test('三限：条数截断取最新 N 条', () => {
  const now = Date.now()
  const list = Array.from({ length: 10 }, (_, i) => msg({ time: now - (10 - i) * 1000, text: `m${i}` }))
  const win = selectWindow(list, { maxMessages: 3, maxAgeMinutes: 30, maxChars: 10_000 })
  assert.deepEqual(win.map((m) => m.text), ['m7', 'm8', 'm9'])
})

test('三限：时间窗过滤过期消息', () => {
  const now = Date.now()
  const list = [
    msg({ time: now - 60 * 60_000, text: '旧' }),
    msg({ time: now - 1000, text: '新' }),
  ]
  const win = selectWindow(list, { maxMessages: 40, maxAgeMinutes: 30, maxChars: 10_000 })
  assert.deepEqual(win.map((m) => m.text), ['新'])
})

test('三限：字数预算从新往旧保留（超预算由旧让位）', () => {
  const now = Date.now()
  const list = [
    msg({ time: now - 3000, text: 'a'.repeat(30) }),
    msg({ time: now - 2000, text: 'b'.repeat(30) }),
    msg({ time: now - 1000, text: 'c'.repeat(30) }),
  ]
  const win = selectWindow(list, { maxMessages: 40, maxAgeMinutes: 30, maxChars: 65 })
  assert.deepEqual(win.map((m) => m.text[0]), ['b', 'c'])
})

test('窗口渲染：HH:MM 名字正文，@我的行尾标注', () => {
  const at = new Date(2026, 0, 1, 14, 3).getTime()
  const text = renderWindow([msg({ time: at, name: '小北', text: '来打游戏', atMe: true })])
  assert.equal(text, '[14:03] 小北: 来打游戏  ←@我')
})

test('唤醒消息：@ 档带群章、正文、背景窗与必回指令', () => {
  const at = new Date(2026, 0, 1, 14, 3).getTime()
  const text = formatWake({
    kind: 'at',
    group: { id: '123456', name: '摸鱼群' },
    senderId: '42',
    senderName: '阿明',
    text: '你来评评理',
    isTrigger: true,
    snapshot: [msg({ time: at, name: '阿明', text: '你来评评理', atMe: true })],
  })
  assert.match(text, /^\[QQ群 摸鱼群\(123456\) \| 阿明\(42\) @了你\]/)
  assert.match(text, /你来评评理/)
  assert.match(text, /── 近期群聊（背景，无需逐条回应）──/)
  assert.match(text, /\[14:03\] 阿明: 你来评评理 {2}←@我/)
  assert.match(text, /必须回应/)
})

test('唤醒消息：普通档无触发正文，结尾给沉默出口', () => {
  const text = formatWake({
    kind: 'plain',
    group: { id: '123456', name: '摸鱼群' },
    senderId: '',
    senderName: '',
    text: '',
    isTrigger: false,
    snapshot: [msg()],
  })
  assert.match(text, /正在聊天/)
  assert.match(text, /stay_silent/)
  assert.match(text, /不必每条都回/)
})

test('唤醒消息：主人普通档带触发正文与主人章，结尾给接话/沉默双出口', () => {
  const text = formatWake({
    kind: 'owner',
    group: { id: '123456', name: '摸鱼群' },
    senderId: '42',
    senderName: '阿明',
    text: '今天几点吃饭',
    isTrigger: true,
    snapshot: [msg({ name: '阿明', text: '今天几点吃饭' })],
  })
  assert.match(text, /^\[QQ群 摸鱼群\(123456\) \| 阿明\(42\) 说了话\]/)
  assert.match(text, /今天几点吃饭/)
  assert.match(text, /send_qq_group/)
  assert.match(text, /stay_silent/)
  assert.doesNotMatch(text, /必须回应/)
})

test('唤醒消息：私聊给私聊章与 send_qq_private 指令', () => {
  const text = formatWake({
    kind: 'private',
    group: null,
    senderId: '42',
    senderName: '阿明',
    text: '在吗',
    isTrigger: true,
    snapshot: [],
  })
  assert.match(text, /^\[QQ私聊 \| 阿明\(42\) 私聊\]/)
  assert.match(text, /send_qq_private/)
  assert.doesNotMatch(text, /近期群聊/)
})

test('来源章去重：名字缺失/等于号码时只写号码，不出现「号码(号码)」', () => {
  const text = formatWake({
    kind: 'private',
    group: null,
    senderId: '3354590676',
    senderName: '3354590676',
    text: '已经加好了',
    isTrigger: true,
    snapshot: [],
  })
  assert.match(text, /^\[QQ私聊 \| 3354590676 私聊\]/)
  assert.doesNotMatch(text, /\(3354590676\)/)
})

test('来源章去重：无发送者的群背景唤醒不再留空括号', () => {
  const text = formatWake({
    kind: 'plain',
    group: { id: '123456', name: '摸鱼群' },
    senderId: '',
    senderName: '',
    text: '',
    isTrigger: false,
    snapshot: [],
  })
  assert.match(text, /^\[QQ群 摸鱼群\(123456\) 正在聊天\]/)
})
