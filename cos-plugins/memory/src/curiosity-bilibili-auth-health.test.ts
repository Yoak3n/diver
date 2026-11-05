import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  readBilibiliAuth,
  writeBilibiliAuth,
  type BilibiliAuth,
} from './curiosity-bilibili-auth.ts'
import {
  ensureBilibiliAuth,
  isDaytime,
  markBilibiliAuthInvalid,
} from './curiosity-bilibili-auth-health.ts'
import type { RefreshOutcome } from './curiosity-bilibili-refresh.ts'

const DAY = new Date(2026, 10, 5, 10, 0, 0).getTime()

test('后台体检：有效/网络失败/过期 + 24h 通知去重', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-bili-health-'))
  try {
    assert.equal(await ensureBilibiliAuth(home, { now: DAY }), null)

    writeBilibiliAuth(home, { sessdata: 's', savedAt: DAY })
    const valid = await ensureBilibiliAuth(home, {
      now: DAY,
      fetchProfile: async () => ({ loggedIn: true, name: '小鱼', mid: '7' }),
    })
    assert.equal(valid?.name, '小鱼')
    assert.equal(readBilibiliAuth(home)?.name, '小鱼')

    const optimistic = await ensureBilibiliAuth(home, {
      now: DAY,
      fetchProfile: async () => ({ loggedIn: false }),
    })
    assert.equal(optimistic?.sessdata, 's', '网络失败不应清空登录态')

    let notified = 0
    const notify = async (): Promise<void> => {
      notified += 1
    }
    const expired = await ensureBilibiliAuth(home, {
      now: DAY,
      fetchProfile: async () => ({ loggedIn: false, expired: true }),
      notify,
    })
    assert.equal(expired, null)
    assert.equal(notified, 1)
    assert.equal(readBilibiliAuth(home)?.invalidAt, DAY)

    const again = await ensureBilibiliAuth(home, {
      now: DAY + 10 * 60_000,
      fetchProfile: async () => {
        throw new Error('不该再打 nav')
      },
      notify,
    })
    assert.equal(again, null)
    assert.equal(notified, 1)

    await ensureBilibiliAuth(home, {
      now: DAY + 24 * 3600_000 + 1,
      fetchProfile: async () => ({ loggedIn: false, expired: true }),
      notify,
    })
    assert.equal(notified, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('凭据已过期：直接标记，不再打 nav', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-bili-expired-'))
  try {
    writeBilibiliAuth(home, { sessdata: 's', savedAt: DAY, expiresAt: DAY - 1000 })
    let notified = 0
    const result = await ensureBilibiliAuth(home, {
      now: DAY,
      fetchProfile: async () => {
        throw new Error('不该再打 nav')
      },
      notify: async () => {
        notified += 1
      },
    })
    assert.equal(result, null)
    assert.equal(notified, 1)
    assert.equal(readBilibiliAuth(home)?.invalidAt, DAY)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('夜间失效不弹通知，白天再补', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-bili-night-'))
  try {
    const night = new Date(2026, 10, 5, 3, 0, 0).getTime()
    assert.equal(isDaytime(night), false)
    writeBilibiliAuth(home, { sessdata: 's', savedAt: night })
    let notified = 0
    await markBilibiliAuthInvalid(home, { sessdata: 's', savedAt: night }, night, {
      notify: async () => {
        notified += 1
      },
    })
    assert.equal(notified, 0)
    assert.equal(readBilibiliAuth(home)?.invalidAt, night)
    assert.equal(readBilibiliAuth(home)?.notifiedAt, undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('到期前自动续期：换新凭据并记录检查时间', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-bili-refresh-'))
  try {
    const old: BilibiliAuth = {
      sessdata: 'old',
      biliJct: 'jct',
      refreshToken: 'rt',
      savedAt: DAY - 20 * 24 * 3600_000,
    }
    writeBilibiliAuth(home, old)
    let refreshed = 0
    const fresh: BilibiliAuth = { ...old, sessdata: 'new', refreshToken: 'rt2', savedAt: DAY }
    const outcome: RefreshOutcome = { status: 'refreshed', auth: fresh }
    const auth = await ensureBilibiliAuth(home, {
      now: DAY,
      refresh: async () => {
        refreshed += 1
        return outcome
      },
      fetchProfile: async () => ({ loggedIn: true, name: '小鱼' }),
    })
    assert.equal(refreshed, 1)
    assert.equal(auth?.sessdata, 'new')
    assert.equal(readBilibiliAuth(home)?.sessdata, 'new')
    assert.equal(readBilibiliAuth(home)?.lastRefreshCheckAt, DAY)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('续期返回 invalid：标记失效并通知', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-bili-refresh-bad-'))
  try {
    writeBilibiliAuth(home, {
      sessdata: 's',
      biliJct: 'jct',
      refreshToken: 'rt',
      savedAt: DAY,
    })
    let notified = 0
    const auth = await ensureBilibiliAuth(home, {
      now: DAY,
      refresh: async () => ({ status: 'invalid', message: '账号未登录' }),
      notify: async () => {
        notified += 1
      },
    })
    assert.equal(auth, null)
    assert.equal(notified, 1)
    assert.equal(readBilibiliAuth(home)?.invalidAt, DAY)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
