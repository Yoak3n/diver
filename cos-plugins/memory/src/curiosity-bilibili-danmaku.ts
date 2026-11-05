// @diver/memory — B 站视频弹幕 XML 解析（纯函数）。
//
// 弹幕是匿名的“人群即时反应”：比评论更碎、更情绪化。这里只取文本样本，
// 不保存发送者 hash / dmid；按时间序均匀采样，避免只看到开头或结尾。

export interface DanmakuSample {
  /** XML 中完整弹幕条数（截断文件也按完整 <d> 计）。 */
  total: number
  sample: string[]
}

const DEFAULT_LIMIT = 120

/** 解析 `<d p="...">text</d>`，解码 XML 实体，均匀采样。 */
export function parseDanmakuXml(xml: string, limit = DEFAULT_LIMIT): DanmakuSample {
  const entries: string[] = []
  let total = 0
  for (const match of xml.matchAll(/<d\b[^>]*>([\s\S]*?)<\/d>/g)) {
    total += 1
    const text = stripMentions(decodeXmlEntities(match[1] ?? '')).replace(/\s+/g, ' ').trim()
    if (text === '' || text.length > 80) continue
    if (!/[\p{L}\p{N}]/u.test(text)) continue // 纯符号/表情
    entries.push(text)
  }
  const unique = [...new Set(entries)]
  const max = Math.max(1, Math.min(500, Math.trunc(limit) || DEFAULT_LIMIT))
  if (unique.length <= max) return { total, sample: unique }

  const step = unique.length / max
  const sample: string[] = []
  for (let i = 0; i < max; i += 1) {
    const item = unique[Math.floor(i * step)]
    if (item !== undefined) sample.push(item)
  }
  return { total, sample }
}

/** 去掉 @用户名（评论/弹幕里的提及），保留正文。 */
export function stripMentions(text: string): string {
  return text.replace(/@[\w\u4e00-\u9fff.-]{1,24}/g, '').replace(/\s+/g, ' ').trim()
}

/** 解码弹幕 XML 里常见的实体（含数字实体）。 */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}
