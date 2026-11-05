// @diver/memory — B 站 cookie 续期的纯解析：CorrespondPath / refresh_csrf / Set-Cookie。

import { constants, publicEncrypt } from 'node:crypto'

import type { BilibiliAuth } from './curiosity-bilibili-auth.ts'

/** 官方 Web 刷新用 RSA 公钥（来自 bilibili-API-collect cookie_refresh.md）。 */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`

/** `refresh_<timestamp>` 的 RSA-OAEP(SHA-256) 小写 hex。 */
export function correspondPath(timestamp: number): string {
  return publicEncrypt(
    { key: PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`refresh_${timestamp}`),
  )
    .toString('hex')
    .toLowerCase()
}

/** 从 correspond 页面 HTML 里取 `id="1-name"` 的 refresh_csrf。 */
export function parseRefreshCsrf(html: string): string | null {
  const match = /id=["']1-name["'][^>]*>([\s\S]*?)</i.exec(html)
  const value = match?.[1]?.trim() ?? ''
  return value === '' ? null : value
}

/** 解析 Set-Cookie 头：只取需要的字段；未知 cookie 忽略。 */
export function applySetCookies(
  auth: BilibiliAuth,
  setCookies: readonly string[],
  now = Date.now(),
): BilibiliAuth {
  const next: BilibiliAuth = { ...auth, savedAt: now }
  for (const header of setCookies) {
    const pair = header.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name === 'SESSDATA') {
      next.sessdata = value
      const expires = /Expires=([^;]+)/i.exec(header)?.[1]
      if (expires !== undefined) {
        const at = Date.parse(expires)
        if (Number.isFinite(at)) next.expiresAt = at
      }
    } else if (name === 'bili_jct') {
      next.biliJct = value
    } else if (name === 'DedeUserID') {
      next.dedeUserId = value
    } else if (name === 'refresh_token') {
      next.refreshToken = value
    }
  }
  return next
}
