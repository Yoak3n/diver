/**
 * 联网搜索：DuckDuckGo HTML / Bing HTML 抓取解析（无 API key）。
 *
 * 对照 bladebro：它用 stealth 浏览器打开搜索引擎再 extract=auto；
 * Explore 场景只要标题/URL/摘要，走 HTTP 抓取更可控、更轻。
 * 引擎失败返回稳定错误码 SEARCH_FAILED，调用方可换 engine 重试。
 */

import { parse, type HTMLElement } from 'node-html-parser'
import { WebError, type WebPolicy } from './policy.ts'
import { fetchPage } from './fetch.ts'

export interface SearchHit {
  title: string
  url: string
  snippet: string
  source: string
}

export interface SearchOutput {
  query: string
  engine: string
  hits: SearchHit[]
  truncated: boolean
}

function textOf(el: HTMLElement | undefined | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function absolutize(href: string, base: string): string | null {
  try {
    const url = new URL(href, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.href
  } catch {
    return null
  }
}

/** DuckDuckGo 跳转链接 `//duckduckgo.com/l/?uddg=...` 还原为真实 URL。 */
function unwrapDdg(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    const uddg = url.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return url.href
  } catch {
    return href
  }
}

async function searchDdg(query: string, policy: WebPolicy): Promise<SearchHit[]> {
  // html.duckduckgo.com 对 UA 友好，无需 JS。
  const endpoint = 'https://html.duckduckgo.com/html/'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'user-agent': policy.userAgent,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
      },
      body: new URLSearchParams({ q: query, kl: 'cn-zh' }).toString(),
    })
    if (!res.ok) throw new WebError('SEARCH_FAILED', `ddg HTTP ${res.status}`)
    const html = await res.text()
    const doc = parse(html)
    const hits: SearchHit[] = []
    for (const result of doc.querySelectorAll('.result, .results_links')) {
      const anchor = result.querySelector('a.result__a, a.result__url, h2 a, a')
      if (!anchor) continue
      const rawHref = anchor.getAttribute('href') ?? ''
      const url = unwrapDdg(absolutize(rawHref, endpoint) ?? rawHref)
      if (!url.startsWith('http')) continue
      const title = textOf(anchor)
      const snippet = textOf(result.querySelector('.result__snippet, .result__snippet'))
      if (!title) continue
      hits.push({ title, url, snippet, source: 'ddg' })
      if (hits.length >= policy.maxResults) break
    }
    return hits
  } catch (error) {
    if (error instanceof WebError) throw error
    if ((error as Error)?.name === 'AbortError') {
      throw new WebError('TIMEOUT', `search timed out after ${policy.timeoutMs}ms`)
    }
    throw new WebError('SEARCH_FAILED', (error as Error)?.message ?? String(error))
  } finally {
    clearTimeout(timer)
  }
}

async function searchBing(query: string, policy: WebPolicy): Promise<SearchHit[]> {
  const endpoint = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans`
  const page = await fetchPage(endpoint, policy)
  const doc = parse(page.body)
  const hits: SearchHit[] = []
  for (const li of doc.querySelectorAll('li.b_algo')) {
    const anchor = li.querySelector('h2 a')
    if (!anchor) continue
    const url = absolutize(anchor.getAttribute('href') ?? '', endpoint)
    if (!url) continue
    const title = textOf(anchor)
    const snippet = textOf(li.querySelector('.b_caption p, p'))
    if (!title) continue
    hits.push({ title, url, snippet, source: 'bing' })
    if (hits.length >= policy.maxResults) break
  }
  return hits
}

/** 执行一次搜索；结果条数受 policy.maxResults 约束。 */
export async function webSearch(query: string, policy: WebPolicy): Promise<SearchOutput> {
  const q = query.trim()
  if (q.length === 0) throw new WebError('SEARCH_FAILED', 'query must be a non-empty string')
  let hits: SearchHit[] = []
  if (policy.engine === 'bing') {
    hits = await searchBing(q, policy)
  } else {
    try {
      hits = await searchDdg(q, policy)
    } catch {
      // ddg 失败自动降级 bing（仍受同一 policy 约束）。
      hits = await searchBing(q, policy)
    }
  }
  return {
    query: q,
    engine: policy.engine,
    hits,
    truncated: hits.length >= policy.maxResults,
  }
}

/** 渲染成模型可读的简洁文本（Explore / web_search 共用）。 */
export function formatSearchHits(output: SearchOutput): string {
  if (output.hits.length === 0) return `No results for: ${output.query}`
  const lines = output.hits.map((hit, i) => {
    const snip = hit.snippet ? `\n   ${hit.snippet.slice(0, 200)}` : ''
    return `${i + 1}. ${hit.title}\n   ${hit.url}${snip}`
  })
  return `Search: ${output.query} (${output.hits.length} hits)\n\n${lines.join('\n\n')}`
}
