import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OnebotClient } from './ws.ts'

/** 最小 WebSocket 替身：只实现客户端用到的事件/状态，方便手工触发 error/close。 */
class FakeSocket extends EventTarget {
  readyState = 0

  close(): void {
    this.readyState = 3
    const event = new Event('close') as Event & { code: number; reason: string }
    event.code = 1006
    event.reason = ''
    this.dispatchEvent(event)
  }

  send(): void {
    throw new Error('not open')
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeClient(sockets: FakeSocket[], statuses: string[]): OnebotClient {
  return new OnebotClient({
    url: 'ws://127.0.0.1:1',
    token: '',
    onGroupMessage: () => {},
    onPrivateMessage: () => {},
    onStatus: (event) => statuses.push(event.status),
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
  })
}

test('error 不发 close 时仍会调度重连（Node 22 拒绝连接的行为）', async () => {
  const sockets: FakeSocket[] = []
  const statuses: string[] = []
  const client = makeClient(sockets, statuses)
  client.start()
  assert.equal(sockets.length, 1)

  sockets[0]!.dispatchEvent(new Event('error'))
  assert.ok(statuses.includes('disconnected'), 'error 必须落成 disconnected，不能停在 connecting')

  // 退避基数 1s：等一个周期后应已发起第二次连接。
  await sleep(1_200)
  assert.equal(sockets.length, 2)
  client.stop()
})

test('error 后紧随 close 只调度一次重连', async () => {
  const sockets: FakeSocket[] = []
  const client = makeClient(sockets, [])
  client.start()
  sockets[0]!.dispatchEvent(new Event('error'))
  sockets[0]!.close()

  await sleep(1_200)
  assert.equal(sockets.length, 2)
  client.stop()
})
