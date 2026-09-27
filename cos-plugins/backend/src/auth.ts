// @diver/backend — P2-1 / BUG-002 鉴权面（backend/ 子模块）。
// CORS 白名单防浏览器跨源读取，Host 回环校验防 DNS rebinding，
// token 常时比较防未授权进程注入（时序侧信道）。

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

// CORS 白名单（不再通配 *）：受信 webview origin 为 dev Vite（127.0.0.1 /
// localhost:1420）与 release Tauri 托管 UI（tauri://localhost /
// http://tauri.localhost）。其它 origin 不发 CORS 头 → 浏览器拦截跨源读取。
const ALLOWED_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'http://127.0.0.1:1420',
  'http://localhost:1420',
])

export function corsOriginAllowed(origin: string | undefined): boolean {
  return origin !== undefined && ALLOWED_ORIGINS.has(origin)
}

export function applyCors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin
  if (origin && corsOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }
}

/** Host 必须是回环名（任意端口），防 DNS rebinding（全路由适用）。 */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  // 去端口：括号 IPv6（[::1]:12331）先按 ] 断，其余按 : 断。
  const bracket = h.indexOf(']')
  const name = bracket >= 0 ? h.slice(0, bracket + 1) : (h.split(':')[0] ?? '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Bearer 头 / x-diver-token 头 / ?token=（EventSource 无法带请求头）。 */
export function tokenOk(req: IncomingMessage, url: URL, expected: string): boolean {
  if (!expected) return false
  const auth = req.headers.authorization ?? ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const headerToken = typeof req.headers['x-diver-token'] === 'string' ? req.headers['x-diver-token'] : ''
  const got = bearer || headerToken || (url.searchParams.get('token') ?? '')
  return tokenEquals(got, expected)
}
