/**
 * 受控 JSON GET：自定义请求头、超时、重定向复检、字节上限。
 *
 * 与 fetchPage 的区别：
 * - 只做 GET（平台观察者永远只读，代码层杜绝写请求）
 * - 允许调用方传 headers（Referer / Cookie / Accept）
 * - 非 2xx 不抛错，交给调用方处理 412/429 与业务错误码
 */

import { resolveHttpUrl } from './fetch.ts'
import { WebError, type WebPolicy } from './policy.ts'

const DEFAULT_MAX_BYTES = 1_500_000

export interface FetchJsonOptions {
  headers?: Record<string, string>
  signal?: AbortSignal
  maxBytes?: number
  accept?: string
}

export interface FetchJsonResult<T> {
  url: string
  finalUrl: string
  status: number
  contentType: string
  body: string
  json: T | null
  etag?: string
  truncated: boolean
}

/** GET 一个 JSON 接口。非 2xx 返回 status/json（可能为 null），不抛错。 */
export async function fetchJson<T>(
  rawUrl: string,
  policy: WebPolicy,
  opts: FetchJsonOptions = {},
): Promise<FetchJsonResult<T>> {
  const url = resolveHttpUrl(rawUrl, policy)
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': policy.userAgent,
        accept: opts.accept ?? 'application/json, text/plain;q=0.9, */*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(opts.headers ?? {}),
      },
    })
    // 重定向后仍需策略校验（防止 open redirect 绕过）。
    resolveHttpUrl(res.url || url.href, policy)

    const maxBytes = Math.max(1024, opts.maxBytes ?? DEFAULT_MAX_BYTES)
    const buf = Buffer.from(await res.arrayBuffer())
    const truncated = buf.byteLength > maxBytes
    const body = buf.subarray(0, truncated ? maxBytes : buf.byteLength).toString('utf8')
    const contentType = res.headers.get('content-type') ?? ''

    let json: T | null = null
    if (body.trim() !== '') {
      try {
        json = JSON.parse(body) as T
      } catch {
        if (res.ok) {
          throw new WebError(
            truncated ? 'TOO_LARGE' : 'INVALID_JSON',
            `invalid JSON from ${url.href}${truncated ? ' (truncated)' : ''}`,
          )
        }
      }
    }
    return {
      url: url.href,
      finalUrl: res.url || url.href,
      status: res.status,
      contentType,
      body,
      json,
      ...(res.headers.get('etag') === null ? {} : { etag: res.headers.get('etag') as string }),
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
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
