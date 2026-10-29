// 入站路由单测：触发回合异常结束且未出话时整回合重排一次（只一次），
// 正常结束/已出话/非 error 原因不重排。COS_HOME 指到临时目录，不碰真实缓冲。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUserMessage } from '@cos/plugin-api'
import type { Agent, UserMessage } from '@cos/plugin-api'

import { resolveConfig } from './config.ts'
import type { PrivateMessageEvent } from './protocol.ts'
import { createRouter } from './router.ts'

/** 最小假 client：私聊昵称走事件自带字段，不触发 API 查询。 */
const client = {
  call: async () => ({}),
} as unknown as Parameters<typeof createRouter>[0]['client']

function privateEvent(text: string): PrivateMessageEvent {
  return {
    self_id: 1,
    time: Math.floor(Date.now() / 1000),
    post_type: 'message',
    message_type: 'private',
    message_id: 1001,
    user_id: 42,
    sender: { user_id: 42, nickname: 'Mou1ght' },
    message: [{ type: 'text', data: { text } }],
  }
}

function harness(home: string) {
  process.env.COS_HOME = home
  const followups: UserMessage[] = []
  const agent = {
    status: 'idle',
    followup: (message: UserMessage) => { followups.push(message) },
    steer: () => {},
  } as unknown as Agent
  const companion = {
    agent: async () => agent,
    message: (text: string, detail?: string) =>
      createUserMessage(text, detail === undefined ? { kind: 'human' } : { kind: 'human', detail }),
  }
  const router = createRouter({
    companion,
    cfg: resolveConfig({ wsUrl: 'ws://127.0.0.1:1' }),
    client,
    canSteer: () => false,
  })
  return { router, followups }
}

test('触发回合 error 且未出话：延迟后整回合重排一次，沿用原来源', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'onebot-router-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { router, followups } = harness(home)

  await router.handlePrivate(privateEvent('现在做到哪一步了？'))
  assert.equal(followups.length, 1, '原始唤醒应投递')

  router.settleTurn({ kind: 'private', userId: '42' }, { kind: 'error' })
  assert.equal(followups.length, 1, '重排要等延迟，不是立即投递')

  t.mock.timers.tick(1500)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(followups.length, 2, '延迟到点后重排一次')
  const retryText = followups[1]!.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
  assert.match(retryText, /重试/)
  assert.equal(followups[1]!.source.detail, 'onebot:u42')

  // 重排后的回合再失败：不再重排（只一次）
  router.settleTurn({ kind: 'private', userId: '42' }, { kind: 'error' })
  t.mock.timers.tick(1500)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(followups.length, 2, '每轮唤醒最多重排一次')
})

test('正常结束、已出话与取消/释放不重排', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'onebot-router-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { router, followups } = harness(home)

  // completed：模型主动沉默，不是故障
  await router.handlePrivate(privateEvent('在吗'))
  router.settleTurn({ kind: 'private', userId: '42' }, { kind: 'completed' })
  t.mock.timers.tick(1500)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(followups.length, 1)

  // error 但本回合已调用出话工具：不重复
  await router.handlePrivate(privateEvent('再说一句'))
  router.noteSpoke()
  router.settleTurn({ kind: 'private', userId: '42' }, { kind: 'error' })
  t.mock.timers.tick(1500)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(followups.length, 2)

  // aborted（会话释放/切模型）：重跑会撞上同一个已释放会话
  await router.handlePrivate(privateEvent('还在吗'))
  router.settleTurn({ kind: 'private', userId: '42' }, { kind: 'aborted' })
  t.mock.timers.tick(1500)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(followups.length, 3)
})
