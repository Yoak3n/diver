/**
 * Explore 执行面：在硬预算内「搜索 → 读前 N 页正文 → 汇总卡片」。
 *
 * 对应 docs/companion-presence-fsm.md §7.4：
 *   执行 = 联网检索 + 摘要（可选读页）；web 检索工具住在执行面。
 *
 * 可控点（相对自由 browse）：
 * - 只暴露 search / read / explore 三步，不做任意点击/填表
 * - maxPages / maxCharsPerPage / maxTotalChars 硬预算
 * - allowHosts / denyHosts / 私网拦截
 * - 每页独立 try/catch，单页失败不拖垮整次 explore
 */

import { WebError, resolvePolicy, type PolicyOverrides, type WebPolicy } from './policy.ts'
import { webSearch, formatSearchHits, type SearchHit } from './search.ts'
import { fetchPage } from './fetch.ts'
import { extractContent, extractOutline } from './extract.ts'
import { bladebroRead } from './browser.ts'

export interface ExplorePageNote {
  url: string
  title: string
  outline: string
  excerpt: string
  error?: string
}

export interface ExploreResult {
  term: string
  query: string
  hits: SearchHit[]
  pages: ExplorePageNote[]
  totalChars: number
  budgetExhausted: boolean
  summary: string
}

function firstSentences(text: string, n: number): string {
  const parts = text
    .split(/(?<=[.!?。！？\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.slice(0, n).join(' ')
}

/**
 * 一次可控 Explore：围绕 term 搜索并读页，产出外部视角卡片。
 * 不写记忆（调用方/memory 插件在 L3 写回）。
 */
export async function exploreTerm(
  term: string,
  base: WebPolicy,
  overrides?: PolicyOverrides & { query?: string; hint?: string; signal?: AbortSignal },
): Promise<ExploreResult> {
  const policy = resolvePolicy(base, overrides)
  const query = (overrides?.query ?? term).trim()
  if (query.length === 0) {
    throw new WebError('SEARCH_FAILED', 'term/query must be a non-empty string')
  }
  const signal = overrides?.signal

  const search = await webSearch(query, policy)
  const pages: ExplorePageNote[] = []
  let totalChars = 0
  let budgetExhausted = false

  for (const hit of search.hits) {
    if (signal?.aborted) break
    if (pages.length >= policy.maxPages) break
    if (totalChars >= policy.maxTotalChars) {
      budgetExhausted = true
      break
    }
    const remaining = policy.maxTotalChars - totalChars
    const budget = Math.min(policy.maxCharsPerPage, remaining)
    try {
      let markdown = ''
      let title = hit.title
      let outline = ''
      let noteError: string | undefined
      let finalUrl = hit.url

      try {
        const page = await fetchPage(hit.url, policy, signal)
        finalUrl = page.finalUrl
        const extracted = extractContent(page.body, budget)
        title = extracted.title || hit.title
        outline = extractOutline(page.body).slice(0, 400)
        markdown = extracted.markdown
        if (markdown.replace(/\s+/g, '').length < 40) {
          noteError = 'EXTRACT_THIN: page body empty or anti-bot shell'
        }
      } catch (error) {
        noteError = error instanceof WebError ? `${error.code}: ${error.message}` : String(error)
      }

      // 反爬壳 / 403：尝试 bladebro 浏览器读页（仍受 budget 约束）。
      if (policy.browserFallback && (noteError !== undefined || markdown.replace(/\s+/g, '').length < 40)) {
        const viaBrowser = await bladebroRead(hit.url, policy)
        if (viaBrowser) {
          markdown = viaBrowser.markdown
          title = viaBrowser.title || title
          noteError = undefined
          outline = extractOutline(`<html><body>${viaBrowser.markdown.slice(0, 200)}</body></html>`).slice(0, 200)
        }
      }

      const bodyOk = markdown.replace(/\s+/g, '').length >= 40
      const excerpt = bodyOk
        ? markdown
        : [
            title && title !== hit.title ? `# ${title}` : '',
            hit.snippet,
            markdown.slice(0, 200),
          ]
            .filter((s) => s.trim().length > 0)
            .join('\n\n')
            .slice(0, budget)

      pages.push({
        url: finalUrl,
        title,
        outline,
        excerpt,
        ...(noteError !== undefined && !bodyOk ? { error: noteError } : {}),
      })
      totalChars += excerpt.length
    } catch (error) {
      const message = error instanceof WebError ? `${error.code}: ${error.message}` : String(error)
      pages.push({
        url: hit.url,
        title: hit.title,
        outline: '',
        excerpt: hit.snippet.slice(0, 300),
        error: message,
      })
    }
  }

  if (totalChars >= policy.maxTotalChars) budgetExhausted = true

  const summary = renderExploreSummary({ term, query, hits: search.hits, pages, totalChars, budgetExhausted, summary: '' })
  return {
    term,
    query,
    hits: search.hits,
    pages,
    totalChars,
    budgetExhausted,
    summary,
  }
}

/** 渲染 Explore 卡片（模型 / 上层写回记忆都用这份）。 */
export function renderExploreSummary(result: Omit<ExploreResult, 'summary'> & { summary?: string }): string {
  const head = `# Explore: ${result.term}\nQuery: ${result.query}\nPages: ${result.pages.length} · chars: ${result.totalChars}${result.budgetExhausted ? ' · [budget exhausted]' : ''}\n`
  const hitBlock = formatSearchHits({ query: result.query, engine: '', hits: result.hits, truncated: false })
  const pageBlocks = result.pages.map((page, i) => {
    const body = page.error
      ? `(failed: ${page.error})\n${page.excerpt}`
      : page.excerpt
    return `## P${i + 1} ${page.title}\nURL: ${page.url}\nOutline: ${page.outline || '(none)'}\n\n${body}`
  })
  return [head, hitBlock, pageBlocks.join('\n\n')].join('\n\n')
}

/** 读单页（web_read 引擎层）。 */
export async function readPage(
  url: string,
  base: WebPolicy,
  overrides?: PolicyOverrides & { outlineOnly?: boolean },
): Promise<{ title: string; markdown: string; outline: string; truncated: boolean; fullLength: number }> {
  const policy = resolvePolicy(base, overrides)
  const page = await fetchPage(url, policy)
  const extracted = extractContent(page.body, policy.maxCharsPerPage)
  return {
    title: extracted.title,
    markdown: extracted.markdown,
    outline: extractOutline(page.body),
    truncated: extracted.truncated,
    fullLength: extracted.fullLength,
  }
}
