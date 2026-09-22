// @diver/basic-tools — 工具输出统一截断（对标 pi truncate.ts）。
// 双限额：行数 + 字节数，先到先截；head 适合 read/list，tail 适合 shell。

export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024
export const GREP_MAX_LINE_LENGTH = 500

export interface TruncationResult {
  content: string
  truncated: boolean
  truncatedBy: 'lines' | 'bytes' | null
  totalLines: number
  totalBytes: number
  outputLines: number
  outputBytes: number
  maxLines: number
  maxBytes: number
}

export interface TruncationOptions {
  maxLines?: number
  maxBytes?: number
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function splitLines(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines
}

/** 从头截断：保留开头完整行（read / ls / find）。 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const totalBytes = Buffer.byteLength(content, 'utf8')
  const lines = splitLines(content)
  const totalLines = lines.length
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      maxLines,
      maxBytes,
    }
  }
  const out: string[] = []
  let bytes = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i]
    const lineBytes = Buffer.byteLength(line, 'utf8') + (i > 0 ? 1 : 0)
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }
    out.push(line)
    bytes += lineBytes
  }
  if (out.length >= maxLines && bytes <= maxBytes) truncatedBy = 'lines'
  const contentOut = out.join('\n')
  return {
    content: contentOut,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: out.length,
    outputBytes: Buffer.byteLength(contentOut, 'utf8'),
    maxLines,
    maxBytes,
  }
}

/** 从尾截断：保留末尾完整行（shell 输出，错误/结论常在末尾）。 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const totalBytes = Buffer.byteLength(content, 'utf8')
  const lines = splitLines(content)
  const totalLines = lines.length
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      maxLines,
      maxBytes,
    }
  }
  const out: string[] = []
  let bytes = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i]
    const lineBytes = Buffer.byteLength(line, 'utf8') + (out.length > 0 ? 1 : 0)
    if (bytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }
    out.unshift(line)
    bytes += lineBytes
  }
  if (out.length >= maxLines && bytes <= maxBytes) truncatedBy = 'lines'
  const contentOut = out.join('\n')
  return {
    content: contentOut,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: out.length,
    outputBytes: Buffer.byteLength(contentOut, 'utf8'),
    maxLines,
    maxBytes,
  }
}

/** 单行按字符截断（grep 预览）。 */
export function truncateLine(line: string, maxChars: number = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false }
  return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true }
}
