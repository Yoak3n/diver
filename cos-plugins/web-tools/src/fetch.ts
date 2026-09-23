/**
 * 受控 HTTP 抓取：超时、大小上限、scheme/host 白黑名单、私网拦截。
 *
 * Explore 不需要 bladebro 的 CDP/stealth；这里只做「读一页正文」的硬边界，
 * 保证任何工具调用都能在预算内失败退出。
 */

import { WebError, type WebPolicy } from './policy.ts'

const MAX_BYTES = 1_500_000

export interface FetchResult {
  url: string
  finalUrl: string
  status: number
  contentType: string
  body: string
  truncated: boolean
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '0.0.0.0' || host === '::1' || host === '::') return true
  // IPv4
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
  }
  // IPv6 ULA / link-local
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
  return false
}

function hostAllowed(hostname: string, policy: WebPolicy): boolean {
  const host = hostname.toLowerCase()
  for (const deny of policy.denyHosts) {
    if (host === deny || host.endsWith(`.${deny}`)) return false
  }
  if (policy.allowHosts.length === 0) return true
  for (const allow of policy.allowHosts) {
    if (host === allow || host.endsWith(`.${allow}`)) return true
  }
  return false
}

/** 校验并解析 URL；只允许 http/https，拒绝私网与策略外 host。 */
export function resolveHttpUrl(raw: string, policy: WebPolicy): URL {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new WebError('INVALID_URL', 'url must be a non-empty string')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new WebError('INVALID_URL', `invalid url: ${trimmed.slice(0, 120)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError('UNSUPPORTED_SCHEME', `only http/https allowed: ${url.protocol}`)
  }
  if (isPrivateHost(url.hostname)) {
    throw new WebError('BLOCKED_HOST', `private/loopback host blocked: ${url.hostname}`)
  }
  if (!hostAllowed(url.hostname, policy)) {
    throw new WebError('BLOCKED_HOST', `host not allowed by policy: ${url.hostname}`)
  }
  return url
}

/** GET 一页 HTML（或纯文本），带超时与字节上限。 */
export async function fetchPage(
  rawUrl: string,
  policy: WebPolicy,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const url = resolveHttpUrl(rawUrl, policy)
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': policy.userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    const contentType = res.headers.get('content-type') ?? ''
    if (!res.ok) {
      throw new WebError('HTTP_ERROR', `HTTP ${res.status} for ${url.href}`)
    }
    // 重定向后仍需策略校验（防止 open redirect 绕过）。
    const finalUrl = new URL(res.url || url.href)
    if (isPrivateHost(finalUrl.hostname) || !hostAllowed(finalUrl.hostname, policy)) {
      throw new WebError('BLOCKED_HOST', `redirect target blocked: ${finalUrl.hostname}`)
    }

    const buf = Buffer.from(await res.arrayBuffer())
    let truncated = false
    let bodyBuf = buf
    if (buf.byteLength > MAX_BYTES) {
      bodyBuf = buf.subarray(0, MAX_BYTES)
      truncated = true
    }
    // 粗编码：优先 charset，缺省 utf-8；失败则 latin1 兜底。
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase()
    let body: string
    try {
      body = new TextDecoder(charset && charset !== 'iso-8859-1' ? charset : 'utf-8', {
        fatal: false,
      }).decode(bodyBuf)
    } catch {
      body = bodyBuf.toString('utf8')
    }
    return {
      url: url.href,
      finalUrl: finalUrl.href,
      status: res.status,
      contentType,
      body,
      truncated,
    }
  } catch (error) {
    if (error instanceof WebError) throw error
    if ((error as Error)?.name === 'AbortError') {
      throw new WebError('TIMEOUT', `fetch timed out after ${policy.timeoutMs}ms: ${url.href}`)
    }
    throw new WebError('HTTP_ERROR', (error as Error)?.message ?? String(error))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
