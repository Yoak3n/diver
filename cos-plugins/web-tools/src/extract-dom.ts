/**
 * HTML 节点文本 / 类型工具（node-html-parser 适配，纯函数）。
 *
 * `innerText` 以 `textContent` 近似（无 live DOM，见 extract.ts 顶部说明）。
 */

import type { HTMLElement, Node, TextNode } from 'node-html-parser'

export function textOf(node: Node | undefined | null): string {
  if (!node) return ''
  return (node as TextNode).textContent ?? ''
}

export function innerText(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim()
}

export function isElement(node: Node): node is HTMLElement {
  return (node as HTMLElement).nodeType === 1
}

export function isText(node: Node): node is TextNode {
  return (node as TextNode).nodeType === 3
}
