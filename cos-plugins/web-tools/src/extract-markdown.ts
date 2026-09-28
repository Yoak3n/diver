/**
 * 块级 HTML → Markdown 折叠（标题 / 段落 / 链接 / 列表 / code / 引用 / 表格），
 * 对齐 bladebro `toMd`；按 max 字符硬截断。
 */

import type { HTMLElement, Node } from 'node-html-parser'

import { innerText, isElement, isText, textOf } from './extract-dom.ts'
import { hiddenByStyle, isAd, NOISE_TAGS, SKIP_TAGS } from './extract-noise.ts'

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
