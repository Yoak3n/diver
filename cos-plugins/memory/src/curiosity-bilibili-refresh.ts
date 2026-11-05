// @diver/memory — B 站 cookie 自动续期（passport 官方 Web 刷新链路）。
//
// 只有这条链路会 POST，且只允许 passport 的 cookie/info、cookie/refresh、
// confirm/refresh；不碰评论/点赞/私信等任何业务写接口。
// bili_jct 只在这里作为 CSRF 使用，观察面仍然只发 SESSDATA。

import { resolveHttpUrl } from '@diver/web-tools/fetch'
import { DEFAULT_POLICY, type WebPolicy } from '@diver/web-tools/policy'

import type { BilibiliAuth } from './curiosity-bilibili-auth.ts'
import { applySetCookies, correspondPath, parseRefreshCsrf } from './curiosity-bilibili-refresh-parse.ts'

export { applySetCookies, correspondPath, parseRefreshCsrf } from './curiosity-bilibili-refresh-parse.ts'

export type RefreshOutcome =
  | { status: 'refreshed'; auth: BilibiliAuth }
  | { status: 'not-needed'; auth: BilibiliAuth }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string }

export interface RefreshHttpResult {
  status: number
  body: string
  setCookies: string[]
}

export type RefreshRequest = (
  url: string,
  opts: {
    method: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
    policy: WebPolicy
  },
) => Promise<RefreshHttpResult>

export interface RefreshOptions {
  now?: number
  policy?: WebPolicy
  request?: RefreshRequest
}

const COOKIE_INFO = 'https://passport.bilibili.com/x/passport-login/web/cookie/info'
const COOKIE_REFRESH = 'https://passport.bilibili.com/x/passport-login/web/cookie/refresh'
const COOKIE_CONFIRM = 'https://passport.bilibili.com/x/passport-login/web/confirm/refresh'
const CORRESPOND = 'https://www.bilibili.com/correspond/1'
const REFERER = 'https://www.bilibili.com/'

/** 执行一次续期：检查 → CorrespondPath → refresh_csrf → refresh → confirm。 */
export async function refreshBilibiliAuth(
  auth: BilibiliAuth,
  opts: RefreshOptions = {},
): Promise<RefreshOutcome> {
  if (auth.biliJct === undefined || auth.biliJct === '' || auth.refreshToken === undefined || auth.refreshToken === '') {
    return { status: 'not-needed', auth }
  }
  const policy = opts.policy ?? DEFAULT_POLICY
  const request = opts.request ?? defaultRequest
  const now = opts.now ?? Date.now()
  try {
    const info = await cookieInfo(auth, request, policy)
    if (info.status !== 'ok') {
      return info.status === 'invalid'
        ? { status: 'invalid', message: info.message }
        : { status: 'error', message: info.message }
    }
    if (!info.data.refresh) return { status: 'not-needed', auth }

    const path = correspondPath(info.data.timestamp > 0 ? info.data.timestamp : now)
    const refreshCsrf = await fetchRefreshCsrf(path, auth, request, policy)
    if (refreshCsrf === null) return { status: 'error', message: '未拿到 refresh_csrf' }

    const oldToken = auth.refreshToken
    const refreshed = await cookieRefresh(auth, refreshCsrf, request, policy, now)
    if (refreshed.status !== 'ok') {
      return refreshed.status === 'invalid'
        ? { status: 'invalid', message: refreshed.message }
        : { status: 'error', message: refreshed.message }
    }
    const confirmed = await confirmRefresh(refreshed.auth, oldToken, request, policy, now)
    if (confirmed.status !== 'ok') {
      // 新 cookie 通常已生效；confirm 失败只告警，让下一次 nav 体检决定。
      console.warn(`[bilibili] 续期确认失败: ${confirmed.message}`)
      return { status: 'refreshed', auth: refreshed.auth }
    }
    return { status: 'refreshed', auth: confirmed.auth }
  } catch (err) {
    return { status: 'error', message: (err as Error)?.message ?? String(err) }
  }
}

type StepResult =
  | { status: 'ok' }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string }

async function cookieInfo(
  auth: BilibiliAuth,
  request: RefreshRequest,
  policy: WebPolicy,
): Promise<StepResult & { data: { refresh: boolean; timestamp: number } }> {
  const res = await request(`${COOKIE_INFO}?csrf=${encodeURIComponent(auth.biliJct ?? '')}`, {
    method: 'GET',
    headers: { cookie: cookieHeader(auth), referer: REFERER },
    policy,
  })
  const json = parseJson(res.body) as {
    code?: number
    message?: string
    data?: { refresh?: boolean; timestamp?: number }
  } | null
  const code = typeof json?.code === 'number' ? json.code : -1
  if (code === -101) return { status: 'invalid', message: '账号未登录', data: { refresh: false, timestamp: 0 } }
  if (res.status >= 400 || code !== 0) {
    return { status: 'error', message: `cookie/info HTTP ${res.status} code ${code}`, data: { refresh: false, timestamp: 0 } }
  }
  return {
    status: 'ok',
    data: {
      refresh: json?.data?.refresh === true,
      timestamp: typeof json?.data?.timestamp === 'number' ? json.data.timestamp : 0,
    },
  }
}

async function fetchRefreshCsrf(
  path: string,
  auth: BilibiliAuth,
  request: RefreshRequest,
  policy: WebPolicy,
): Promise<string | null> {
  const res = await request(`${CORRESPOND}/${path}`, {
    method: 'GET',
    headers: {
      cookie: cookieHeader(auth),
      referer: REFERER,
      accept: 'text/html,application/xhtml+xml',
    },
    policy,
  })
  if (res.status >= 400) return null
  return parseRefreshCsrf(res.body)
}

async function cookieRefresh(
  auth: BilibiliAuth,
  refreshCsrf: string,
  request: RefreshRequest,
  policy: WebPolicy,
  now: number,
): Promise<StepResult & { auth: BilibiliAuth }> {
  const body = new URLSearchParams({
    csrf: auth.biliJct ?? '',
    refresh_csrf: refreshCsrf,
    source: 'main_web',
    refresh_token: auth.refreshToken ?? '',
  }).toString()
  const res = await request(COOKIE_REFRESH, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(auth),
      referer: REFERER,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    policy,
  })
  const json = parseJson(res.body) as {
    code?: number
    message?: string
    data?: { refresh_token?: string }
  } | null
  const code = typeof json?.code === 'number' ? json.code : -1
  if (code === -101 || code === -111 || code === 86095) {
    return { status: 'invalid', message: json?.message ?? `续期失败 code ${code}`, auth }
  }
  if (res.status >= 400 || code !== 0) {
    return { status: 'error', message: `cookie/refresh HTTP ${res.status} code ${code}`, auth }
  }
  const next = applySetCookies(auth, res.setCookies, now)
  if (typeof json?.data?.refresh_token === 'string' && json.data.refresh_token !== '') {
    next.refreshToken = json.data.refresh_token
  }
  return { status: 'ok', auth: next }
}

async function confirmRefresh(
  auth: BilibiliAuth,
  oldRefreshToken: string,
  request: RefreshRequest,
  policy: WebPolicy,
  now: number,
): Promise<StepResult & { auth: BilibiliAuth }> {
  const body = new URLSearchParams({
    csrf: auth.biliJct ?? '',
    refresh_token: oldRefreshToken,
  }).toString()
  const res = await request(COOKIE_CONFIRM, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(auth),
      referer: REFERER,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
    policy,
  })
  const json = parseJson(res.body) as { code?: number; message?: string } | null
  const code = typeof json?.code === 'number' ? json.code : -1
  if (res.status >= 400 || code !== 0) {
    return { status: 'error', message: `confirm/refresh HTTP ${res.status} code ${code}`, auth }
  }
  return { status: 'ok', auth: applySetCookies(auth, res.setCookies, now) }
}

function cookieHeader(auth: BilibiliAuth): string {
  const parts = [`SESSDATA=${auth.sessdata}`]
  if (auth.biliJct !== undefined) parts.push(`bili_jct=${auth.biliJct}`)
  if (auth.refreshToken !== undefined) parts.push(`refresh_token=${auth.refreshToken}`)
  if (auth.dedeUserId !== undefined) parts.push(`DedeUserID=${auth.dedeUserId}`)
  return parts.join('; ')
}

async function defaultRequest(
  url: string,
  opts: {
    method: 'GET' | 'POST'
    headers?: Record<string, string>
    body?: string
    policy: WebPolicy
  },
): Promise<RefreshHttpResult> {
  const target = resolveHttpUrl(url, opts.policy)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.policy.timeoutMs)
  try {
    const res = await fetch(target, {
      method: opts.method,
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': opts.policy.userAgent,
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(opts.headers ?? {}),
      },
      ...(opts.body === undefined ? {} : { body: opts.body }),
    })
    resolveHttpUrl(res.url || target.href, opts.policy)
    return {
      status: res.status,
      body: await res.text(),
      setCookies: typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [],
    }
  } finally {
    clearTimeout(timer)
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return null
  }
}
