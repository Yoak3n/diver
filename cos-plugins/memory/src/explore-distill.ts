// @diver/memory — 探索结果提炼：LLM 输出的解析 + 无 LLM 摘录兜底（纯函数）。

import type { ExploreResult } from '@diver/web-tools/explore'

export interface Distilled {
  /** 一句话结论（≤120 字，汇报也用这一句）。 */
  oneLine: string
  /** ≤3 条要点。 */
  points: string[]
  /** 平台见闻的短主题（≤20 字），用作 topic 名。 */
  subject?: string
  /** 平台见闻的“人群视角”（评论区/弹幕的整体情绪或分歧）。 */
  perspective?: string
}

/** 无 LLM 时的兜底：取页面/搜索片段的首句。 */
export function extractiveDistill(term: string, result: ExploreResult): Distilled {
  // 订阅/平台 payload：没有 pages/hits，正文就在 summary 里。
  if (result.pages.length === 0 && result.hits.length === 0 && result.summary.trim() !== '') {
    const sentences = firstSentences(result.summary, 4)
    return {
      oneLine: (sentences[0] ?? `关于「${term}」的更新`).slice(0, 120),
      points: sentences.slice(1, 4).map((s) => s.slice(0, 80)),
    }
  }
  const page = result.pages.find((p) => !p.error && p.excerpt.trim() !== '')
  const first = page !== undefined ? firstSentences(page.excerpt, 2).join(' ') : ''
  const snippet = result.hits.find((h) => h.snippet.trim() !== '')?.snippet ?? ''
  const oneLine = (first || firstSentences(snippet, 1)[0] || `关于「${term}」的检索结果`).slice(0, 120)

  const points: string[] = []
  for (const p of result.pages) {
    if (p.error) continue
    const sentence = firstSentences(p.excerpt, 1)[0]
    if (sentence !== undefined && sentence !== '' && sentence !== oneLine) points.push(sentence.slice(0, 80))
    if (points.length >= 3) break
  }
  if (points.length === 0) {
    for (const hit of result.hits.slice(0, 3)) {
      const sentence = firstSentences(hit.snippet, 1)[0]
      if (sentence !== undefined && sentence !== '') points.push(sentence.slice(0, 80))
    }
  }
  return { oneLine, points: points.slice(0, 3) }
}

/** 解析模型输出：优先 JSON，其次「主题/结论/- 要点/人群视角」纯文本。 */
export function parseDistilled(raw: string): Distilled | null {
  const text = raw.trim()
  if (text === '') return null
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text) as {
        subject?: unknown
        oneLine?: unknown
        points?: unknown
        perspective?: unknown
      }
      const oneLine = typeof obj.oneLine === 'string' ? obj.oneLine.trim() : ''
      const points = Array.isArray(obj.points)
        ? obj.points.filter((p): p is string => typeof p === 'string' && p.trim() !== '').slice(0, 3)
        : []
      if (oneLine !== '') {
        return withOptional(
          { oneLine: oneLine.slice(0, 120), points },
          typeof obj.subject === 'string' ? obj.subject : undefined,
          typeof obj.perspective === 'string' ? obj.perspective : undefined,
        )
      }
    } catch {
      /* 落回文本解析 */
    }
  }
  const lines = text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return null

  const subjectLine = lines.find((line) => /^主题[:：]/.test(line))
  const perspectiveLine = lines.find((line) => /^人群视角[:：]/.test(line))
  const conclusionLine = lines.find((line) => /^(一句话结论|结论)[:：]/.test(line))
  const special = new Set([subjectLine, perspectiveLine, conclusionLine].filter((line): line is string => line !== undefined))
  const first = conclusionLine !== undefined
    ? stripPrefix(conclusionLine, ['一句话结论', '结论'])
    : (lines.find((line) => !special.has(line) && !/^[-*•]/.test(line)) ?? '')
  if (first.length < 2) return null
  const points = lines
    .filter((line) => /^[-*•]/.test(line) || /^\d+[.、]/.test(line))
    .map(stripBullet)
    .filter((line) => line !== '')
    .slice(0, 3)
  return withOptional(
    { oneLine: first.slice(0, 120), points },
    subjectLine !== undefined ? stripPrefix(subjectLine, ['主题']) : undefined,
    perspectiveLine !== undefined ? stripPrefix(perspectiveLine, ['人群视角']) : undefined,
  )
}

function withOptional(base: Distilled, subject?: string, perspective?: string): Distilled {
  const value = subject?.trim()
  const view = perspective?.trim()
  return {
    ...base,
    ...(value === undefined || value === '' ? {} : { subject: value.slice(0, 40) }),
    ...(view === undefined || view === '' ? {} : { perspective: view.slice(0, 120) }),
  }
}

function stripPrefix(line: string, labels: readonly string[]): string {
  for (const label of labels) {
    const prefix = `${label}：`
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim()
    const ascii = `${label}:`
    if (line.startsWith(ascii)) return line.slice(ascii.length).trim()
  }
  return line.trim()
}

function stripBullet(line: string): string {
  return line.replace(/^[-*•]\s*/, '').replace(/^\d+[.、]\s*/, '').trim()
}

function firstSentences(text: string, n: number): string[] {
  return text
    .replace(/^#.*$/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    // 中文句号直接断句；英文句点只在后跟空白/结尾时断（避免拆开 v0.2.14）。
    .split(/(?<=[。！？])|(?<=[.!?])(?=\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, n)
}
