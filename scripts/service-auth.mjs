// P2-1 / BUG-002：本地服务鉴权令牌解析（冒烟/测试脚本共用）。
// 取值顺序：DIVER_TOKEN 环境变量 → debug 形态壳端落盘的 <app_data>/service-token。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function serviceToken() {
  const fromEnv = (process.env.DIVER_TOKEN ?? '').trim()
  if (fromEnv) return fromEnv
  const base = process.env.APPDATA ?? join(process.env.HOME ?? '', '.config')
  try {
    return readFileSync(join(base, 'com.diver.companion', 'service-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

/** 把令牌挂到请求头（已有 Authorization 不覆盖）。 */
export function authHeaders(headers = {}) {
  const token = serviceToken()
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers
}

/** SSE / GET 无法保证带请求头时：把令牌拼进 URL 查询参数。 */
export function authUrl(url) {
  const token = serviceToken()
  if (!token) return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
}
