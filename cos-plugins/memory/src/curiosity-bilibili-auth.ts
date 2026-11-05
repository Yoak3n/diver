// @diver/memory — B 站扫码登录（只读账号）。
//
// 保存 SESSDATA / bili_jct / refresh_token，仅用于读取与 cookie 自动续期；
// 代码层没有任何评论/点赞/私信等写接口，token 不回传、不日志。
// 凭据文件：$COS_HOME/curiosity/bilibili-auth.json（0600），不进 config/state。

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fetchJson, type FetchJsonOptions, type FetchJsonResult } from '@diver/web-tools/fetch-json'
import { DEFAULT_POLICY, type WebPolicy } from '@diver/web-tools/policy'

import { curiosityRoot } from './curiosity-state.ts'

export interface BilibiliAuth {
  sessdata: string
  /** CSRF token：只用于 passport 续期，绝不用于任何写接口。 */
  biliJct?: string
  /** 持久化刷新口令（登录接口返回）。 */
  refreshToken?: string
  dedeUserId?: string
  mid?: string
  name?: string
  savedAt: number
  expiresAt?: number
  /** 上次续期检查时间（24h 节流）。 */
  lastRefreshCheckAt?: number
  /** 后台体检发现失效的时间；有值时平台层直接按匿名处理。 */
  invalidAt?: number
  /** 最近一次失效通知时间（24h 去重）。 */
  notifiedAt?: number
}

export interface QrLogin {
  key: string
  url: string
}

export type QrPollStatus = 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'

export interface QrPollResult {
  status: QrPollStatus
  auth?: BilibiliAuth
  message?: string
}

export type FetchJsonLike = <T>(
  url: string,
  policy: WebPolicy,
  opts?: FetchJsonOptions,
) => Promise<FetchJsonResult<T>>

const QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const QR_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
const NAV = 'https://api.bilibili.com/x/web-interface/nav'

export function authPath(home: string): string {
  return join(curiosityRoot(home), 'bilibili-auth.json')
}

export function readBilibiliAuth(home: string): BilibiliAuth | null {
  const path = authPath(home)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BilibiliAuth>
    if (typeof raw.sessdata !== 'string' || raw.sessdata.trim() === '') return null
    return {
      sessdata: raw.sessdata,
      ...(typeof raw.biliJct === 'string' && raw.biliJct !== '' ? { biliJct: raw.biliJct } : {}),
      ...(typeof raw.refreshToken === 'string' && raw.refreshToken !== '' ? { refreshToken: raw.refreshToken } : {}),
      ...(typeof raw.dedeUserId === 'string' && raw.dedeUserId !== '' ? { dedeUserId: raw.dedeUserId } : {}),
      ...(typeof raw.mid === 'string' && raw.mid !== '' ? { mid: raw.mid } : {}),
      ...(typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : {}),
      savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
      ...(typeof raw.expiresAt === 'number' ? { expiresAt: raw.expiresAt } : {}),
      ...(typeof raw.lastRefreshCheckAt === 'number' ? { lastRefreshCheckAt: raw.lastRefreshCheckAt } : {}),
      ...(typeof raw.invalidAt === 'number' ? { invalidAt: raw.invalidAt } : {}),
      ...(typeof raw.notifiedAt === 'number' ? { notifiedAt: raw.notifiedAt } : {}),
    }
  } catch {
    return null
  }
}

export function writeBilibiliAuth(home: string, auth: BilibiliAuth): void {
  const dir = curiosityRoot(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = authPath(home)
  writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(dir, 0o700)
    chmodSync(path, 0o600)
  } catch {
    /* Windows 等平台忽略权限位 */
  }
}

export function clearBilibiliAuth(home: string): void {
  rmSync(authPath(home), { force: true })
}

/** 请求扫码二维码（未登录的 passport 接口）。 */
export async function requestQrLogin(
  fetchJsonImpl: FetchJsonLike = fetchJson,
): Promise<QrLogin> {
  const res = await fetchJsonImpl<{ code?: number; message?: string; data?: { url?: string; qrcode_key?: string } }>(
    QR_GENERATE,
    DEFAULT_POLICY,
    { maxBytes: 64 * 1024 },
  )
  const data = res.json?.data
  if (res.status >= 400 || res.json?.code !== 0 || typeof data?.qrcode_key !== 'string' || typeof data.url !== 'string') {
    throw new Error(`二维码生成失败: HTTP ${res.status} code ${res.json?.code ?? '?'}`)
  }
  return { key: data.qrcode_key, url: data.url }
}

/** 轮询扫码结果；确认后返回 SESSDATA/bili_jct/refresh_token。 */
export async function pollQrLogin(
  key: string,
  fetchJsonImpl: FetchJsonLike = fetchJson,
  now = Date.now(),
): Promise<QrPollResult> {
  const res = await fetchJsonImpl<{
    code?: number
    message?: string
    data?: { code?: number; message?: string; url?: string; refresh_token?: string }
  }>(
    `${QR_POLL}?qrcode_key=${encodeURIComponent(key)}`,
    DEFAULT_POLICY,
    { maxBytes: 64 * 1024 },
  )
  return parseQrPoll(res.json, now)
}

/** 纯函数：扫码状态码 → 状态；成功时提取 SESSDATA/bili_jct + refresh_token。 */
export function parseQrPoll(json: unknown, now = Date.now()): QrPollResult {
  const root = json as {
    code?: unknown
    data?: { code?: unknown; message?: unknown; url?: unknown; refresh_token?: unknown }
  } | null
  const data = root?.data
  const code = typeof data?.code === 'number' ? data.code : typeof root?.code === 'number' ? root.code : -1
  if (code === 0) {
    const auth = typeof data?.url === 'string' ? parseLoginCookieUrl(data.url, now) : null
    if (auth === null) return { status: 'error', message: '登录成功但未拿到 SESSDATA' }
    if (typeof data?.refresh_token === 'string' && data.refresh_token !== '') {
      auth.refreshToken = data.refresh_token
    }
    return { status: 'confirmed', auth }
  }
  if (code === 86101) return { status: 'waiting' }
  if (code === 86090) return { status: 'scanned' }
  if (code === 86038) return { status: 'expired' }
  const message = typeof data?.message === 'string' ? data.message : `二维码状态码 ${code}`
  return { status: 'error', message }
}

/** 从跨域登录 URL 中取 SESSDATA/bili_jct/DedeUserID/Expires；refresh_token 由响应单独带出。 */
export function parseLoginCookieUrl(raw: string, now = Date.now()): BilibiliAuth | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  // 保留 URL 中的原样编码（SESSDATA 常含 %2C 逗号），不要 decode 后再拼 Cookie。
  const sessdata = /[?&]SESSDATA=([^&]*)/.exec(raw)?.[1] ?? ''
  if (sessdata === '') return null
  const biliJct = /[?&]bili_jct=([^&]*)/.exec(raw)?.[1] ?? ''
  const dede = url.searchParams.get('DedeUserID') ?? ''
  const expires = Number(url.searchParams.get('Expires'))
  return {
    sessdata,
    ...(biliJct === '' ? {} : { biliJct }),
    ...(dede === '' ? {} : { dedeUserId: dede }),
    savedAt: now,
    ...(Number.isFinite(expires) && expires > 0 ? { expiresAt: expires > 1e12 ? expires : expires * 1000 } : {}),
  }
}

/** 用 SESSDATA 查 nav，确认登录态并取昵称/UID；失败不抛错。 */
export async function fetchLoginProfile(
  auth: BilibiliAuth,
  fetchJsonImpl: FetchJsonLike = fetchJson,
): Promise<{ loggedIn: boolean; name?: string; mid?: string; expired?: boolean }> {
  try {
    const res = await fetchJsonImpl<{
      code?: number
      data?: { isLogin?: boolean; uname?: string; mid?: number }
    }>(NAV, DEFAULT_POLICY, {
      headers: { cookie: `SESSDATA=${auth.sessdata}` },
      maxBytes: 64 * 1024,
    })
    // -101/401/403 才是登录失效；412/429 等风控不能误判成过期。
    if (res.json?.code === -101 || res.status === 401 || res.status === 403) {
      return { loggedIn: false, expired: true }
    }
    if (res.status >= 400 || res.json?.code !== 0 || res.json.data?.isLogin !== true) {
      return { loggedIn: false }
    }
    return {
      loggedIn: true,
      ...(typeof res.json.data.uname === 'string' ? { name: res.json.data.uname } : {}),
      ...(typeof res.json.data.mid === 'number' ? { mid: String(res.json.data.mid) } : {}),
    }
  } catch {
    return { loggedIn: false }
  }
}
