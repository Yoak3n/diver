/**
 * 页面级入口：标题 + 主内容 markdown 抽取（budget 硬截断）与轻量大纲。
 */

import { parse, type HTMLElement } from 'node-html-parser'

import { innerText } from './extract-dom.ts'
import { findMain } from './extract-main.ts'
import { toMarkdown } from './extract-markdown.ts'
import { plainTextFallback } from './extract-noise.ts'

export interface ExtractResult {
  title: string
  markdown: string
  truncated: boolean
  fullLength: number
}

/** 从 HTML 抽出标题 + 主内容 markdown（budget 硬截断）。 */
export function extractContent(html: string, budget: number): ExtractResult {
  const doc = parse(html)
  const titleRaw = (doc.querySelector('title')?.textContent ?? '').trim()
  const h1El = doc.querySelector('h1')
  const h1 = h1El ? innerText(h1El) : ''
  const title = titleRaw || h1
  const main = findMain(doc)
  const fullLength = Math.max(innerText(main).length, innerText(doc.querySelector('body') ?? doc).length)
  let markdown = toMarkdown(main, budget)
  // bladebro 在 live DOM 上 innerText 较可靠；静态 HTML 对 SPA/百科壳页
  // 常抽出空壳 —— 过短时退回纯文本，保证 Explore 有料。
  if (markdown.replace(/\s+/g, '').length < 80) {
    const plain = plainTextFallback(doc, budget)
    if (plain.replace(/\s+/g, '').length > markdown.replace(/\s+/g, '').length) {
      markdown = plain
    }
  }
  return {
    title,
    markdown,
    truncated: fullLength > budget,
    fullLength,
  }
}

/** 轻量大纲：标题层级（对照 bladebro capture_outline）。 */
export function extractOutline(html: string): string {
  const doc = parse(html)
  const title = (doc.querySelector('title')?.textContent ?? '').trim()
  const lines: string[] = []
  if (title) lines.push(title)
  const hs = doc.querySelectorAll('h1, h2, h3, h4, h5, h6')
  if (hs.length === 0) return lines.length > 0 ? `${lines[0]}\n(no headings)` : '(no headings)'
  for (const h of hs) {
    const tag = (h.tagName ?? 'H2').toUpperCase()
    const lvl = Number(tag.charAt(1)) || 2
    const txt = innerText(h)
    if (!txt) continue
    lines.push(`${'  '.repeat(Math.max(0, lvl - 1))}${txt}`)
  }
  return lines.join('\n')
}
