/**
 * HTML → 可读 Markdown 抽取。
 *
 * 算法移植自 bladebro `page/perception.rs` 的 `findMain` / `isAd` / `toMd`
 * （E:\GitVault\bladebro），语义对齐 `see mode=content`：
 * - 主内容：semantic main/article → 常见内容选择器 → 文本密度（text − 2×link）
 * - 去噪：SKIP/NOISE 标签、广告 class/id/data-*、hidden
 * - 块级转 Markdown：标题 / 段落 / 链接 / 列表 / code / 引用 / 表格
 *
 * 与 bladebro 的差异：无 live DOM（用 node-html-parser 解析静态 HTML），
 * `innerText` 以 `textContent` 近似；站点特化（商品/Reddit/GitHub）v1 不做，
 * Explore 以通用正文为主，更可控。
 */

import { parse, type HTMLElement, type Node, type TextNode } from 'node-html-parser'

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'SVG',
  'TEMPLATE',
  'META',
  'LINK',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
])

const NOISE_TAGS = new Set(['NAV', 'FOOTER', 'HEADER', 'ASIDE'])

const AD_CLASS_RE =
  /dfp|advert|sponsored|ad-container|ad-wrapper|ad-slot|ad-banner|ad-feedback|adbanner|adsense|adblock|ad-label|ads-label|ads-container|mol-ads|promoted|adsbygoogle|google-ad|doubleclick|adfeedback/
const AD_ID_RE = /dfp|advert|sponsored|google_ads|doubleclick/

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

function textOf(node: Node | undefined | null): string {
  if (!node) return ''
  return (node as TextNode).textContent ?? ''
}

function innerText(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function isElement(node: Node): node is HTMLElement {
  return (node as HTMLElement).nodeType === 1
}

function isText(node: Node): node is TextNode {
  return (node as TextNode).nodeType === 3
}

/** bladebro isAd：class / id / data-* / aria-label 命中广告启发式。 */
export function isAd(el: HTMLElement): boolean {
  const cl = (el.getAttribute('class') ?? '').toLowerCase()
  const id = (el.getAttribute('id') ?? '').toLowerCase()
  if (AD_CLASS_RE.test(cl)) return true
  if (AD_ID_RE.test(id)) return true
  if (
    el.hasAttribute('data-ad')
    || el.hasAttribute('data-ad-slot')
    || el.hasAttribute('data-ad-client')
    || el.hasAttribute('data-google-query-id')
  ) {
    return true
  }
  const tag = (el.tagName ?? '').toUpperCase()
  if (tag === 'INS' && AD_CLASS_RE.test(cl)) return true
  const al = (el.getAttribute('aria-label') ?? '').toLowerCase()
  if (al.includes('advertisement')) return true
  return false
}

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

function hiddenByStyle(el: HTMLElement): boolean {
  const style = el.getAttribute('style') ?? ''
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)
}

/**
 * bladebro toMd：把主内容子树折叠为 markdown，按 max 字符硬截断。
 */
export function toMarkdown(root: HTMLElement, max: number): string {
  let out = ''
  let len = 0
  const add = (s: string): void => {
    if (len >= max) return
    const room = max - len
    const chunk = s.length > room ? s.slice(0, room) : s
    out += chunk
    len += chunk.length
  }

  const walkChildren = (el: HTMLElement): void => {
    for (const child of el.childNodes) walk(child)
  }

  const walk = (node: Node): void => {
    if (len >= max) return
    if (isText(node)) {
      const t = textOf(node).replace(/\s+/g, ' ').trim()
      if (t) add(`${t} `)
      return
    }
    if (!isElement(node)) return
    const el = node
    const tag = (el.tagName ?? '').toUpperCase()
    if (SKIP_TAGS.has(tag)) return
    if (el.hasAttribute('hidden')) return
    if (hiddenByStyle(el)) return
    if (NOISE_TAGS.has(tag)) return
    if (isAd(el)) return

    switch (tag) {
      case 'H1':
        add(`\n# ${innerText(el)}\n\n`)
        return
      case 'H2':
        add(`\n## ${innerText(el)}\n\n`)
        return
      case 'H3':
        add(`\n### ${innerText(el)}\n\n`)
        return
      case 'H4':
        add(`\n#### ${innerText(el)}\n\n`)
        return
      case 'H5':
        add(`\n##### ${innerText(el)}\n\n`)
        return
      case 'H6':
        add(`\n###### ${innerText(el)}\n\n`)
        return
      case 'P':
        walkChildren(el)
        add('\n\n')
        return
      case 'A': {
        const tx = innerText(el)
        const hr = el.getAttribute('href') ?? ''
        if (tx && hr && hr !== '#' && !hr.startsWith('javascript:')) {
          if (tx === hr) add(tx)
          else add(`[${tx}](${hr})`)
        } else if (tx) {
          add(tx)
        }
        return
      }
      case 'LI':
        add('- ')
        walkChildren(el)
        add('\n')
        return
      case 'UL':
      case 'OL':
        walkChildren(el)
        add('\n')
        return
      case 'CODE': {
        const parent = el.parentNode as HTMLElement | undefined
        if (parent && (parent.tagName ?? '').toUpperCase() === 'PRE') return
        add(`\`${innerText(el)}\``)
        return
      }
      case 'PRE':
        add(`\n\`\`\`\n${innerText(el)}\n\`\`\`\n\n`)
        return
      case 'BLOCKQUOTE':
        add(`\n> ${innerText(el).replace(/\n/g, '\n> ')}\n\n`)
        return
      case 'IMG': {
        const al = el.getAttribute('alt') ?? ''
        const sr = el.getAttribute('src') ?? ''
        if (al) add(`![${al}](${sr})`)
        return
      }
      case 'TABLE': {
        const rows = el.querySelectorAll('tr')
        const hasHeader = el.querySelector('th, thead') !== null
        if (hasHeader && rows.length > 0 && rows.length < 50) {
          for (let i = 0; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('th, td')
            const row = cells.map((c) => innerText(c).replace(/\|/g, '\\|'))
            add(`| ${row.join(' | ')} |\n`)
            if (i === 0) add(`|${row.map(() => '---').join('|')}|\n`)
          }
          add('\n\n')
          return
        }
        walkChildren(el)
        add('\n')
        return
      }
      case 'BR':
        add('\n')
        return
      case 'HR':
        add('\n---\n\n')
        return
      case 'STRONG':
      case 'B':
        add('**')
        walkChildren(el)
        add('**')
        return
      case 'EM':
      case 'I':
        add('*')
        walkChildren(el)
        add('*')
        return
      case 'TR':
      case 'THEAD':
      case 'TBODY':
      case 'TFOOT':
        walkChildren(el)
        add('\n')
        return
      case 'TD':
      case 'TH':
        walkChildren(el)
        add(' ')
        return
      default:
        walkChildren(el)
    }
  }

  walk(root)
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

export interface ExtractResult {
  title: string
  markdown: string
  truncated: boolean
  fullLength: number
}

/** 兜底：主内容抽出过少时，去掉脚本/样式后取 body 可见文本。 */
function plainTextFallback(doc: HTMLElement, budget: number): string {
  const body = doc.querySelector('body') ?? doc
  for (const el of body.querySelectorAll('script, style, noscript, svg, template')) {
    el.remove()
  }
  for (const el of body.querySelectorAll('*')) {
    if (NOISE_TAGS.has((el.tagName ?? '').toUpperCase()) || isAd(el)) el.remove()
  }
  const text = (body.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > budget ? text.slice(0, budget) : text
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
