// 缓冲落盘单测：运行期追加计数截断、启动目录全量截断、坏行跳过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUFFER_KEEP_LINES,
  TRIM_EVERY_APPENDS,
  appendMessage,
  groupBufferPath,
  privateBufferPath,
  readMessages,
  trimAllBuffers,
} from './buffer-store.ts'

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'onebot-buffer-'))
}

function msg(i: number) {
  return { time: i, userId: 'u', name: 'n', text: `m${i}`, messageId: i, atMe: false }
}

test('运行期动态截断：累计追加达到阈值后压回保留上限', () => {
  const home = tmpHome()
  const file = groupBufferPath('123', home)
  try {
    // 每 4 条截回 5 行：12 条追加后只剩最新 5 行
    for (let i = 0; i < 12; i += 1) {
      appendMessage(file, msg(i), { keep: 5, trimEvery: 4 })
    }
    const messages = readMessages(file)
    assert.equal(messages.length, 5)
    assert.equal(messages[messages.length - 1].text, 'm11')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('未达阈值不截断（计数跨调用累计）', () => {
  const home = tmpHome()
  const file = groupBufferPath('456', home)
  try {
    for (let i = 0; i < 3; i += 1) {
      appendMessage(file, msg(i), { keep: 2, trimEvery: 10 })
    }
    assert.equal(readMessages(file).length, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('启动全量截断：群与私聊目录都扫，含未监听旧群', () => {
  const home = tmpHome()
  const groupFile = groupBufferPath('123', home)
  const staleFile = groupBufferPath('999', home)
  const privateFile = privateBufferPath('456', home)
  try {
    for (let i = 0; i < 30; i += 1) {
      // trimEvery 拉高避免触发运行期截断，专测启动路径
      appendMessage(groupFile, msg(i), { trimEvery: 10_000 })
      appendMessage(staleFile, msg(i), { trimEvery: 10_000 })
      appendMessage(privateFile, msg(i), { trimEvery: 10_000 })
    }
    trimAllBuffers(home, 20)
    assert.equal(readMessages(groupFile).length, 20)
    assert.equal(readMessages(staleFile).length, 20)
    assert.equal(readMessages(privateFile).length, 20)
    assert.equal(readMessages(groupFile)[19].text, 'm29')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('readMessages：坏行与空行跳过，不阻断恢复', () => {
  const home = tmpHome()
  const file = privateBufferPath('789', home)
  try {
    mkdirSync(join(home, 'onebot', 'users'), { recursive: true })
    writeFileSync(file, 'not json\n\n{"time":1,"userId":"u","name":"n","text":"ok","messageId":1,"atMe":false}\n', 'utf-8')
    const messages = readMessages(file)
    assert.equal(messages.length, 1)
    assert.equal(messages[0].text, 'ok')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('默认常量：保留 2000 行、每 500 条追加截一次', () => {
  assert.equal(BUFFER_KEEP_LINES, 2000)
  assert.equal(TRIM_EVERY_APPENDS, 500)
})
