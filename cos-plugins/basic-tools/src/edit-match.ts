// @diver/basic-tools — edit 分层模糊匹配（策略子集对标 ZCode edit-matchers）。
//
// exact 失败后按宽→更宽顺序尝试；命中后用文件里的真实片段替换，避免
// 模型抄错空白/引号/行号前缀时整段 edit 失败。
// replace_all 时禁用宽匹配（line_trimmed / indentation_flexible），防止误伤。

export type EditMatchStrategy =
  | 'exact'
  | 'quote_normalized'
  | 'line_number_prefix_stripped'
  | 'escape_normalized'
  | 'line_trimmed'
  | 'indentation_flexible'

export type EditMatchResult =
  | { status: 'matched'; actualString: string; strategy: EditMatchStrategy; candidateCount: number }
  | { status: 'ambiguous'; strategy: EditMatchStrategy; candidateCount: number }
  | { status: 'not_found' }

const BROAD_MATCHERS = new Set<EditMatchStrategy>(['line_trimmed', 'indentation_flexible'])

const LEFT_SINGLE = '‘'
const RIGHT_SINGLE = '’'
const LEFT_DOUBLE = '“'
const RIGHT_DOUBLE = '”'

interface Candidate {
  value: string
  index: number
}

function collectSubstring(content: string, search: string): Candidate[] {
  if (search.length === 0) return []
  const candidates: Candidate[] = []
  let position = 0
  while (position <= content.length) {
    const index = content.indexOf(search, position)
    if (index === -1) break
    candidates.push({ value: search, index })
    position = index + Math.max(search.length, 1)
  }
  return candidates
}

function normalizeQuotes(value: string): string {
  return value
    .replaceAll(LEFT_SINGLE, "'")
    .replaceAll(RIGHT_SINGLE, "'")
    .replaceAll(LEFT_DOUBLE, '"')
    .replaceAll(RIGHT_DOUBLE, '"')
}

function collectNormalized(
  content: string,
  search: string,
  normalize: (v: string) => string,
): Candidate[] {
  const normalizedContent = normalize(content)
  const normalizedSearch = normalize(search)
  if (normalizedSearch.length === 0) return []
  const candidates: Candidate[] = []
  let position = 0
  while (position <= normalizedContent.length) {
    const index = normalizedContent.indexOf(normalizedSearch, position)
    if (index === -1) break
    // 索引基于归一文本；长度用原文 search.length 近似取片段（引号等宽）。
    const actual = content.slice(index, index + search.length)
    candidates.push({ value: actual, index })
    position = index + Math.max(normalizedSearch.length, 1)
  }
  return candidates
}

function stripLineNumberPrefixes(search: string): string | null {
  const lines = search.split('\n')
  const stripped = lines.map((line) => {
    const colon = line.match(/^\d+: (.*)$/)
    if (colon) return colon[1] ?? ''
    const tab = line.match(/^\d+\t(.*)$/)
    if (tab) return tab[1] ?? ''
    return null
  })
  return stripped.every((line): line is string => line !== null) ? stripped.join('\n') : null
}

function unescapeVisible(search: string): string {
  return search.replace(/\\([ntr"'`\\$])/g, (_m, token: string) => {
    switch (token) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      default: return token
    }
  })
}

function trimTrailingEmptyLine(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === '') return lines.slice(0, -1)
  return lines
}

function blockCandidate(lines: string[], startLine: number, lineCount: number): Candidate {
  let offset = 0
  for (let i = 0; i < startLine; i++) offset += lines[i].length + 1
  return { value: lines.slice(startLine, startLine + lineCount).join('\n'), index: offset }
}

function collectLineTrimmed(content: string, search: string): Candidate[] {
  const contentLines = content.split('\n')
  const searchLines = trimTrailingEmptyLine(search.split('\n'))
  if (searchLines.length === 0) return []
  const candidates: Candidate[] = []
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const block = contentLines.slice(i, i + searchLines.length)
    if (!block.every((line, offset) => line.trim() === searchLines[offset].trim())) continue
    candidates.push(blockCandidate(contentLines, i, searchLines.length))
  }
  return candidates
}

function removeCommonIndent(lines: string[]): string {
  const nonEmpty = lines.filter((l) => l.trim().length > 0)
  if (nonEmpty.length === 0) return lines.join('\n')
  const minIndent = Math.min(...nonEmpty.map((l) => l.match(/^[\t ]*/)?.[0].length ?? 0))
  return lines.map((l) => (l.trim().length === 0 ? l : l.slice(minIndent))).join('\n')
}

function collectIndentationFlexible(content: string, search: string): Candidate[] {
  const contentLines = content.split('\n')
  const searchLines = trimTrailingEmptyLine(search.split('\n'))
  if (searchLines.length < 2) return []
  const normalizedSearch = removeCommonIndent(searchLines)
  const candidates: Candidate[] = []
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const block = contentLines.slice(i, i + searchLines.length)
    if (removeCommonIndent(block) !== normalizedSearch) continue
    candidates.push(blockCandidate(contentLines, i, searchLines.length))
  }
  return candidates
}

function toResult(strategy: EditMatchStrategy, candidates: Candidate[]): EditMatchResult {
  const unique = [...new Set(candidates.map((c) => c.value))]
  if (unique.length !== 1) {
    return { status: 'ambiguous', strategy, candidateCount: candidates.length }
  }
  return { status: 'matched', actualString: unique[0] ?? '', strategy, candidateCount: candidates.length }
}

/**
 * 在 content 中定位 old_string。exact 优先，失败后按策略放宽。
 * replace_all 时跳过宽匹配，避免「几乎对上」的误替换。
 */
export function findEditMatch(input: {
  content: string
  search: string
  replaceAll: boolean
}): EditMatchResult {
  const exact = collectSubstring(input.content, input.search)
  if (exact.length > 0) return toResult('exact', exact)

  const strategies: EditMatchStrategy[] = [
    'quote_normalized',
    'line_number_prefix_stripped',
    'escape_normalized',
    'line_trimmed',
    'indentation_flexible',
  ]

  for (const strategy of strategies) {
    if (input.replaceAll && BROAD_MATCHERS.has(strategy)) continue
    let candidates: Candidate[] = []
    switch (strategy) {
      case 'quote_normalized':
        candidates = collectNormalized(input.content, input.search, normalizeQuotes)
        break
      case 'line_number_prefix_stripped': {
        const stripped = stripLineNumberPrefixes(input.search)
        if (stripped === null || stripped === input.search) continue
        candidates = collectSubstring(input.content, stripped)
        break
      }
      case 'escape_normalized': {
        const unescaped = unescapeVisible(input.search)
        if (unescaped === input.search) continue
        candidates = collectSubstring(input.content, unescaped)
        break
      }
      case 'line_trimmed':
        candidates = collectLineTrimmed(input.content, input.search)
        break
      case 'indentation_flexible':
        candidates = collectIndentationFlexible(input.content, input.search)
        break
    }
    if (candidates.length === 0) continue
    return toResult(strategy, candidates)
  }

  return { status: 'not_found' }
}
