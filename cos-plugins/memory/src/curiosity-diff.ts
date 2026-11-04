// @diver/memory — 订阅页面 diff（纯函数）。
//
// 不做完整 LCS：更新日志/文档页的诉求是「这次新增了什么」，
// 多重集差集足够稳，且不会因为段落移动把整页当新增。

/** 规范化行：压空白、去空行；保留原始顺序。 */
export function normalizeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
}

/** next 相对 prev 的新增行（多重集差集，保留 next 顺序）。 */
export function addedLines(prev: readonly string[], next: readonly string[]): string[] {
  const before = new Map<string, number>()
  for (const line of prev) before.set(line, (before.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of next) {
    const remaining = before.get(line) ?? 0
    if (remaining > 0) before.set(line, remaining - 1)
    else added.push(line)
  }
  return added
}

/** 取新增行拼成一段，按字符上限截断。 */
export function clipLines(lines: readonly string[], maxChars = 800): string {
  const text = lines.join('\n')
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

/** FNV-1a 32 位：页面内容指纹（不引 crypto，纯函数可测）。 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}
