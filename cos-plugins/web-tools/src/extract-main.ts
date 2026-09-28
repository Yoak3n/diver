/**
 * 主内容定位：semantic main/article → 常见内容选择器 → 文本密度打分
 * （text − 2×link，对齐 bladebro `findMain`）。
 */

import type { HTMLElement } from 'node-html-parser'

import { innerText } from './extract-dom.ts'

const MAIN_SELECTORS = [
  '#content',
  '.content',
  '#main-content',
  '.main-content',
  '.post',
  '.article',
  '.entry-content',
  '.post-body',
  '.article-body',
  '.story-body',
  '#article-body',
  // 中文站常见正文容器（百科 / 专栏 / 博客）
  '.lemma-summary',
  '.lemmaWgt-lemmaSummary',
  '.main-content',
  '.rich_media_content',
  '.Post-RichTextContainer',
  '.RichText',
  '#content_views',
  '.article-content',
  '.markdown-body',
  '.blog-content-box',
]

/** bladebro findMain：main/article → 内容选择器 → 文本密度打分。 */
export function findMain(doc: HTMLElement): HTMLElement {
  const main = doc.querySelector('main, [role="main"]')
  if (main && innerText(main).length > 200) return main
  const article = doc.querySelector('article')
  if (article && innerText(article).length > 200) return article
  for (const sel of MAIN_SELECTORS) {
    const el = doc.querySelector(sel)
    if (el && innerText(el).length > 200) return el
  }
  let best: HTMLElement | null = null
  let bestScore = 0
  for (const el of doc.querySelectorAll('div, section, table')) {
    const t = innerText(el)
    if (t.length < 200) continue
    let linkText = 0
    for (const a of el.querySelectorAll('a')) linkText += innerText(a).length
    const score = t.length - linkText * 2
    if (score > bestScore) {
      bestScore = score
      best = el
    }
  }
  return best ?? doc.querySelector('body') ?? doc
}
