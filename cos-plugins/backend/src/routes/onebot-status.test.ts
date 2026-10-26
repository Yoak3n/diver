import assert from 'node:assert/strict'
import { test } from 'node:test'

import { onebotStatusView } from './onebot-status.ts'

test('插件未加载（无 onebotStatus 服务）→ unavailable', () => {
  assert.deepEqual(onebotStatusView({ get: () => undefined }), {
    available: false,
    state: 'unavailable',
  })
})

test('服务快照原样透出（available=true）', () => {
  const view = onebotStatusView({
    get: (name) =>
      name === 'onebotStatus'
        ? { snapshot: () => ({ state: 'online', url: 'ws://127.0.0.1:3001', selfId: 1 }) }
        : undefined,
  })
  assert.deepEqual(view, {
    available: true,
    state: 'online',
    url: 'ws://127.0.0.1:3001',
    selfId: 1,
  })
})

test('快照抛错 → 降级 unavailable 并带原因', () => {
  const view = onebotStatusView({
    get: () => ({
      snapshot: () => {
        throw new Error('boom')
      },
    }),
  })
  assert.deepEqual(view, { available: false, state: 'unavailable', error: 'boom' })
})
