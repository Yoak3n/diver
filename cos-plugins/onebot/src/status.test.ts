import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OnebotStatusStore } from './status.ts'

test('初始状态为 connecting，url 不含 token', () => {
  const store = new OnebotStatusStore('ws://127.0.0.1:3001', 1_000)
  assert.deepEqual(store.snapshot(1_000), {
    state: 'connecting',
    url: 'ws://127.0.0.1:3001',
    since: 1_000,
    attempts: 0,
  })
})

test('sleep 记录原因并清空重连计数', () => {
  const store = new OnebotStatusStore('ws://127.0.0.1:3001', 1_000)
  store.offline('boom', 2_000, 1_500)
  store.sleep('未配置 wsUrl', 2_000)
  assert.deepEqual(store.snapshot(2_000), {
    state: 'sleeping',
    reason: '未配置 wsUrl',
    url: 'ws://127.0.0.1:3001',
    since: 2_000,
    attempts: 0,
  })
})

test('登录成功才进入 online，并清零重连计数', () => {
  const store = new OnebotStatusStore('ws://127.0.0.1:3001', 1_000)
  store.offline('连接已断开', 1_000, 1_100)
  store.offline('连接已断开', 2_000, 2_200)
  store.connecting(3_000)
  store.online(3143775623, '鱼', 3_100)
  assert.deepEqual(store.snapshot(3_100), {
    state: 'online',
    url: 'ws://127.0.0.1:3001',
    selfId: 3143775623,
    nickname: '鱼',
    since: 3_100,
    attempts: 0,
  })
})

test('offline 保留上次登录身份，retryInMs 按快照时间递减到 0', () => {
  const store = new OnebotStatusStore('ws://127.0.0.1:3001', 1_000)
  store.connecting(1_000)
  store.online(3143775623, '鱼', 1_100)
  store.offline('连接已关闭（code 1005）', 5_000, 2_000)
  assert.deepEqual(store.snapshot(3_000), {
    state: 'offline',
    url: 'ws://127.0.0.1:3001',
    selfId: 3143775623,
    nickname: '鱼',
    since: 2_000,
    lastError: '连接已关闭（code 1005）',
    attempts: 1,
    retryInMs: 4_000,
  })
  assert.equal(store.snapshot(8_000).retryInMs, 0)
})

test('断开后晚到的 get_login_info 成功/失败不覆盖 offline', () => {
  const store = new OnebotStatusStore('ws://127.0.0.1:3001', 1_000)
  store.connecting(1_000)
  store.offline('连接已断开', 1_000, 1_100)
  store.online(3143775623, '鱼', 1_200)
  assert.equal(store.snapshot(1_200).state, 'offline')
  store.loginFailed('OneBot API 超时：get_login_info', 1_300)
  assert.equal(store.snapshot(1_300).state, 'offline')
})

test('WS open 但登录失败时保持 connecting 并记录原因', () => {
  const store = new OnebotStatusStore('ws://127.0.0.1:3001', 1_000)
  store.connecting(1_000)
  store.loginFailed('OneBot API 超时：get_login_info', 1_500)
  assert.deepEqual(store.snapshot(1_500), {
    state: 'connecting',
    url: 'ws://127.0.0.1:3001',
    since: 1_500,
    lastError: 'OneBot API 超时：get_login_info',
    attempts: 0,
  })
})

test('snapshot 返回副本，外部改动不影响内部状态', () => {
  const store = new OnebotStatusStore('ws://127.0.0.1:3001', 1_000)
  const snap = store.snapshot(1_000)
  snap.state = 'online'
  assert.equal(store.snapshot(1_000).state, 'connecting')
})
