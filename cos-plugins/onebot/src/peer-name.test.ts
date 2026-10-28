// 私聊昵称解析单测：事件名优先、API 兜底、缓存与并发合流。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createPrivateNameResolver, eventNameOf } from './peer-name.ts'

type Handler = (params: Record<string, unknown>) => unknown

function fakeClient(handlers: Record<string, Handler>) {
  const calls: string[] = []
  return {
    calls,
    async call<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push(action)
      const handler = handlers[action]
      if (handler === undefined) throw new Error(`unexpected action: ${action}`)
      return handler(params) as T
    },
  }
}

test('事件显示名：私聊优先昵称；缺失或等于号码时才需要解析', () => {
  assert.equal(eventNameOf({ user_id: 42, nickname: '阿明' }), '阿明')
  // 群名片是群内身份，私聊优先昵称
  assert.equal(eventNameOf({ user_id: 42, nickname: '阿明', card: '小北' }), '阿明')
  assert.equal(eventNameOf({ user_id: 42, nickname: '   ' }), undefined)
  assert.equal(eventNameOf({ user_id: 42, nickname: '42' }), undefined)
  assert.equal(eventNameOf(undefined), undefined)
})

test('事件自带昵称：直接使用，不调用 API', async () => {
  const client = fakeClient({})
  const resolve = createPrivateNameResolver(client)
  const name = await resolve('42', { user_id: 42, nickname: '阿明' })
  assert.equal(name, '阿明')
  assert.deepEqual(client.calls, [])
})

test('事件缺昵称：get_stranger_info 兜底并缓存', async () => {
  const client = fakeClient({
    get_stranger_info: () => ({ user_id: 42, nickname: '主人' }),
  })
  const resolve = createPrivateNameResolver(client)
  assert.equal(await resolve('42', { user_id: 42 }), '主人')
  // 第二条消息不再打 API
  assert.equal(await resolve('42', { user_id: 42 }), '主人')
  assert.deepEqual(client.calls, ['get_stranger_info'])
})

test('stranger_info 失败：好友列表兜底（昵称优先，备注次之）', async () => {
  const client = fakeClient({
    get_stranger_info: () => {
      throw new Error('not supported')
    },
    get_friend_list: () => [
      { user_id: 42, nickname: '阿明', remark: '' },
      { user_id: 43, nickname: '', remark: '备注名' },
    ],
  })
  const resolve = createPrivateNameResolver(client)
  assert.equal(await resolve('42', { user_id: 42 }), '阿明')
  assert.equal(await resolve('43', { user_id: 43 }), '备注名')
  assert.deepEqual(client.calls, [
    'get_stranger_info',
    'get_friend_list',
    'get_stranger_info',
    'get_friend_list',
  ])
})

test('全部解析失败：退回号码，且不缓存失败结果', async () => {
  let attempts = 0
  const client = fakeClient({
    get_stranger_info: () => {
      attempts += 1
      if (attempts === 1) throw new Error('timeout')
      return { user_id: 42, nickname: '迟到的昵称' }
    },
    get_friend_list: () => [],
  })
  const resolve = createPrivateNameResolver(client)
  assert.equal(await resolve('42', { user_id: 42 }), '42')
  assert.equal(await resolve('42', { user_id: 42 }), '迟到的昵称')
})

test('并发解析同一用户：合流成一次 API 调用', async () => {
  let calls = 0
  const client = fakeClient({
    get_stranger_info: () => {
      calls += 1
      return { nickname: '阿明' }
    },
  })
  const resolve = createPrivateNameResolver(client)
  const [a, b] = await Promise.all([
    resolve('42', { user_id: 42 }),
    resolve('42', { user_id: 42 }),
  ])
  assert.equal(a, '阿明')
  assert.equal(b, '阿明')
  assert.equal(calls, 1)
})
