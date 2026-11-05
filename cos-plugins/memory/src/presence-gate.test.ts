import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isIdleAlone, type PresenceSnapshotLike } from './presence-gate.ts'

const NOW = 1_700_000_000_000

function snapshot(overrides: Partial<PresenceSnapshotLike> = {}): PresenceSnapshotLike {
  return {
    enabled: true,
    phase_name: 'passive',
    regime: 'normal',
    user_input_active: false,
    proactive: { last_chat_at: NOW - 30 * 60_000 },
    ...overrides,
  }
}

test('闲置/独处矩阵', () => {
  const opts = { now: NOW, idleMinutes: 20, gateEnabled: true }
  assert.equal(isIdleAlone(snapshot(), opts), true)
  assert.equal(isIdleAlone(null, opts), false)
  assert.equal(isIdleAlone(snapshot(), { ...opts, gateEnabled: false }), true)
  assert.equal(isIdleAlone(snapshot({ user_input_active: true }), opts), false)
  assert.equal(isIdleAlone(snapshot({ phase_name: 'thinking' }), opts), false)
  assert.equal(isIdleAlone(snapshot({ phase_name: 'receptive' }), opts), true)
  assert.equal(isIdleAlone(snapshot({ regime: 'sleep' }), opts), false)
  assert.equal(isIdleAlone(snapshot({ regime: 'focus' }), opts), false)
  assert.equal(isIdleAlone(snapshot({ enabled: false }), opts), false)
  assert.equal(
    isIdleAlone(snapshot({ proactive: { last_chat_at: NOW - 5 * 60_000 } }), opts),
    false,
  )
  assert.equal(isIdleAlone(snapshot({ proactive: { last_chat_at: 0 } }), opts), true)
})
