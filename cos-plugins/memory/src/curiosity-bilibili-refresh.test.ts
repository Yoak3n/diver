import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { BilibiliAuth } from './curiosity-bilibili-auth.ts'
import {
  applySetCookies,
  correspondPath,
  parseRefreshCsrf,
  refreshBilibiliAuth,
  type RefreshRequest,
} from './curiosity-bilibili-refresh.ts'
import { DEFAULT_POLICY } from '@diver/web-tools/policy'

const NOW = 1_700_000_000_000
const auth: BilibiliAuth = { sessdata: 'old', biliJct: 'jct', refreshToken: 'rt', savedAt: NOW }

test('CorrespondPath：RSA-OAEP 输出 256 位 hex', () => {
  const path = correspondPath(1_700_000_000_000)
  assert.match(path, /^[0-9a-f]{256}$/)
})

test('refresh_csrf 解析', () => {
  assert.equal(parseRefreshCsrf('<div id="1-name">token-123</div>'), 'token-123')
  assert.equal(parseRefreshCsrf('<div id=\'1-name\'>x</div>'), 'x')
  assert.equal(parseRefreshCsrf('<html></html>'), null)
})

test('Set-Cookie 只更新需要的字段，未知 cookie 忽略', () => {
  const next = applySetCookies(
    auth,
    [
      'SESSDATA=new; Path=/; Expires=Wed, 01 Jan 2027 00:00:00 GMT; HttpOnly',
      'bili_jct=newjct; Path=/',
      'DedeUserID=42; Path=/',
      'refresh_token=newrt; Path=/',
      'b_nut=other; Path=/',
    ],
    NOW,
  )
  assert.equal(next.sessdata, 'new')
  assert.equal(next.biliJct, 'newjct')
  assert.equal(next.dedeUserId, '42')
  assert.equal(next.refreshToken, 'newrt')
  assert.ok((next.expiresAt ?? 0) > NOW)
})

test('续期完整链路：info → correspond → refresh → confirm', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = []
  const request: RefreshRequest = async (url, opts) => {
    calls.push({ url, method: opts.method, ...(opts.body === undefined ? {} : { body: opts.body }) })
    if (url.includes('/cookie/info')) {
      return { status: 200, body: JSON.stringify({ code: 0, data: { refresh: true, timestamp: NOW } }), setCookies: [] }
    }
    if (url.includes('/correspond/1/')) {
      return { status: 200, body: '<div id="1-name">csrf-token</div>', setCookies: [] }
    }
    if (url.includes('/cookie/refresh')) {
      return {
        status: 200,
        body: JSON.stringify({ code: 0, data: { refresh_token: 'new-rt' } }),
        setCookies: ['SESSDATA=new; Path=/', 'bili_jct=newjct; Path=/', 'DedeUserID=42; Path=/'],
      }
    }
    if (url.includes('/confirm/refresh')) {
      return { status: 200, body: JSON.stringify({ code: 0 }), setCookies: [] }
    }
    throw new Error(`unexpected ${url}`)
  }

  const outcome = await refreshBilibiliAuth(auth, { now: NOW, request, policy: DEFAULT_POLICY })
  assert.equal(outcome.status, 'refreshed')
  assert.equal(outcome.status === 'refreshed' ? outcome.auth.sessdata : '', 'new')
  assert.equal(outcome.status === 'refreshed' ? outcome.auth.biliJct : '', 'newjct')
  assert.equal(outcome.status === 'refreshed' ? outcome.auth.refreshToken : '', 'new-rt')
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET', 'POST', 'POST'])
  const refreshCall = calls.find((c) => c.url.includes('/cookie/refresh'))
  assert.ok(refreshCall?.body?.includes('csrf=jct'))
  assert.ok(refreshCall?.body?.includes('refresh_csrf=csrf-token'))
  assert.ok(refreshCall?.body?.includes('refresh_token=rt'))
  const confirmCall = calls.find((c) => c.url.includes('/confirm/refresh'))
  assert.ok(confirmCall?.body?.includes('csrf=newjct'))
  assert.ok(confirmCall?.body?.includes('refresh_token=rt'))
})

test('无需续期 / 未登录 / 风控', async () => {
  const make = (json: unknown, status = 200): RefreshRequest => async () => ({
    status,
    body: JSON.stringify(json),
    setCookies: [],
  })
  assert.equal(
    (await refreshBilibiliAuth(auth, { request: make({ code: 0, data: { refresh: false } }) })).status,
    'not-needed',
  )
  assert.equal(
    (await refreshBilibiliAuth(auth, { request: make({ code: -101, message: '未登录' }) })).status,
    'invalid',
  )
  assert.equal(
    (await refreshBilibiliAuth(auth, { request: make({ code: -412, message: 'blocked' }, 412) })).status,
    'error',
  )
})
