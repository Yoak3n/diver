import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  authPath,
  clearBilibiliAuth,
  fetchLoginProfile,
  parseLoginCookieUrl,
  parseQrPoll,
  readBilibiliAuth,
  writeBilibiliAuth,
  type FetchJsonLike,
} from './curiosity-bilibili-auth.ts'

const NOW = 1_700_000_000_000

test('扫码确认：提取 SESSDATA/bili_jct/refresh_token', () => {
  const result = parseQrPoll({
    code: 0,
    data: {
      code: 0,
      url: 'https://passport.biligame.com/crossDomain?SESSDATA=abc%2C123&DedeUserID=42&bili_jct=JCT&Expires=1700000000',
      refresh_token: 'RT',
    },
  }, NOW)
  assert.equal(result.status, 'confirmed')
  assert.deepEqual(result.auth, {
    sessdata: 'abc%2C123',
    biliJct: 'JCT',
    refreshToken: 'RT',
    dedeUserId: '42',
    savedAt: NOW,
    expiresAt: 1_700_000_000_000,
  })
})

test('扫码状态码映射', () => {
  assert.equal(parseQrPoll({ code: 0, data: { code: 86101 } }).status, 'waiting')
  assert.equal(parseQrPoll({ code: 0, data: { code: 86090 } }).status, 'scanned')
  assert.equal(parseQrPoll({ code: 0, data: { code: 86038 } }).status, 'expired')
  assert.equal(parseQrPoll({ code: -412, message: 'blocked' }).status, 'error')
})

test('登录 URL 缺少 SESSDATA 时失败', () => {
  assert.equal(parseLoginCookieUrl('https://passport.bilibili.com/x?DedeUserID=42', NOW), null)
})

test('凭据文件 0600，可读可清', () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-bili-auth-'))
  try {
    writeBilibiliAuth(home, { sessdata: 's', savedAt: NOW })
    assert.equal(readBilibiliAuth(home)?.sessdata, 's')
    if (process.platform !== 'win32') {
      assert.equal(statSync(authPath(home)).mode & 0o777, 0o600)
    }
    clearBilibiliAuth(home)
    assert.equal(readBilibiliAuth(home), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('登录态校验：nav isLogin', async () => {
  const ok = await fetchLoginProfile(
    { sessdata: 's', savedAt: NOW },
    (async <T>() => ({ json: { code: 0, data: { isLogin: true, uname: '小鱼', mid: 7 } } } as never)) as FetchJsonLike,
  )
  assert.deepEqual(ok, { loggedIn: true, name: '小鱼', mid: '7' })
})

test('nav 风控不等于登录失效', async () => {
  const risk = await fetchLoginProfile(
    { sessdata: 's', savedAt: NOW },
    (async <T>() => ({ status: 412, json: { code: -412 } } as never)) as FetchJsonLike,
  )
  assert.deepEqual(risk, { loggedIn: false })
  const expired = await fetchLoginProfile(
    { sessdata: 's', savedAt: NOW },
    (async <T>() => ({ status: 200, json: { code: -101 } } as never)) as FetchJsonLike,
  )
  assert.deepEqual(expired, { loggedIn: false, expired: true })
})
