/**
 * 可控联网策略 — Explore / web_* 工具的预算与安全边界。
 *
 * 设计目标（对照 bladebro 的 token 预算 / auto-extract）：Explore 不做
 * 自由浏览，只做「搜索 → 读正文 → 摘要」，每次调用都在硬预算内结束。
 */

/** 单次 HTTP 请求 / 工具调用的策略。 */
export interface WebPolicy {
  /** web_search 最多返回几条结果。 */
  maxResults: number
  /** web_explore 最多读几页。 */
  maxPages: number
  /** 单页正文最大字符数（extract budget）。 */
  maxCharsPerPage: number
  /** 一次 web_explore 累计正文最大字符数。 */
  maxTotalChars: number
  /** 单次 HTTP 超时（毫秒）。 */
  timeoutMs: number
  /** 允许的 host 后缀（空 = 公网皆可；仍拦截私网）。 */
  allowHosts: string[]
  /** 拒绝的 host 后缀（优先于 allow）。 */
  denyHosts: string[]
  /** 搜索后端：ddg | bing（默认 ddg，失败可切换）。 */
  engine: 'ddg' | 'bing'
  /** HTTP 抽取过薄/失败时是否尝试 bladebro CLI（需本机有二进制）。 */
  browserFallback: boolean
  /** UA；默认桌面 Chrome 风格，避免被搜索引擎直接丢弃。 */
  userAgent: string
}

export const DEFAULT_POLICY: WebPolicy = {
  maxResults: 8,
  maxPages: 3,
  maxCharsPerPage: 6000,
  maxTotalChars: 16000,
  timeoutMs: 15_000,
  allowHosts: [],
  denyHosts: [],
  engine: 'ddg',
  browserFallback: true,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

/** 工具参数里允许覆盖的策略子集（全部可选）。host 列表接受逗号字符串。 */
export type PolicyOverrides = Partial<
  Pick<
    WebPolicy,
    | 'maxResults'
    | 'maxPages'
    | 'maxCharsPerPage'
    | 'maxTotalChars'
    | 'timeoutMs'
    | 'engine'
  >
> & {
  allowHosts?: string | string[]
  denyHosts?: string | string[]
  browserFallback?: boolean
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function asHostList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const list = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    for (const part of item.split(',')) {
      const host = part.trim().toLowerCase()
      if (host.length > 0) out.push(host)
    }
  }
  return out
}

/** 合并默认策略与调用方覆盖（数值夹紧，列表归一）。 */
export function resolvePolicy(base: WebPolicy, overrides?: PolicyOverrides): WebPolicy {
  const o = overrides ?? {}
  return {
    maxResults: clampInt(o.maxResults, base.maxResults, 1, 20),
    maxPages: clampInt(o.maxPages, base.maxPages, 1, 8),
    maxCharsPerPage: clampInt(o.maxCharsPerPage, base.maxCharsPerPage, 400, 50_000),
    maxTotalChars: clampInt(o.maxTotalChars, base.maxTotalChars, 800, 200_000),
    timeoutMs: clampInt(o.timeoutMs, base.timeoutMs, 2_000, 60_000),
    allowHosts: o.allowHosts !== undefined ? asHostList(o.allowHosts) : [...base.allowHosts],
    denyHosts: o.denyHosts !== undefined ? asHostList(o.denyHosts) : [...base.denyHosts],
    engine: o.engine === 'bing' || o.engine === 'ddg' ? o.engine : base.engine,
    browserFallback: o.browserFallback ?? base.browserFallback,
    userAgent: base.userAgent,
  }
}

/** 稳定错误码（模型可分支；与 grep 的 SEARCH_* 风格对齐）。 */
export type WebErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_HOST'
  | 'UNSUPPORTED_SCHEME'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'TOO_LARGE'
  | 'SEARCH_FAILED'
  | 'EXTRACT_FAILED'
  | 'BUDGET_EXHAUSTED'

export class WebError extends Error {
  readonly code: WebErrorCode

  constructor(code: WebErrorCode, message: string) {
    super(message)
    this.name = 'WebError'
    this.code = code
  }
}
