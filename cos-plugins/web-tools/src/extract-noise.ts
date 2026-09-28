/**
 * 去噪判定：跳过标签 / 噪声容器 / 广告启发式 / 隐藏元素，
 * 以及主内容过少时的纯文本兜底。
 */

import type { HTMLElement } from 'node-html-parser'

import { innerText } from './extract-dom.ts'

export const SKIP_TAGS = new Set([
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

export const NOISE_TAGS = new Set(['NAV', 'FOOTER', 'HEADER', 'ASIDE'])

const AD_CLASS_RE =
  /dfp|advert|sponsored|ad-container|ad-wrapper|ad-slot|ad-banner|ad-feedback|adbanner|adsense|adblock|ad-label|ads-label|ads-container|mol-ads|promoted|adsbygoogle|google-ad|doubleclick|adfeedback/
const AD_ID_RE = /dfp|advert|sponsored|google_ads|doubleclick/

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

export function hiddenByStyle(el: HTMLElement): boolean {
  const style = el.getAttribute('style') ?? ''
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)
}

/** 兜底：主内容抽出过少时，去掉脚本/样式后取 body 可见文本。 */
export function plainTextFallback(doc: HTMLElement, budget: number): string {
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
