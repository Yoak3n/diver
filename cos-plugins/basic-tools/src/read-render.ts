// @diver/basic-tools — read 渲染层（移植自 DSH 上游 @deepseek-ai/dsh-tool-fs/read-render）。
// 纯函数：把解码文本切成带行号、受字节预算约束的窗口，渲染 OpenCode 风格 envelope。

import { DiverFsError } from './fsio.ts'

/** 单行最大字符数（readMaxLineLength 默认）。 */
export const READ_MAX_LINE_LENGTH = 2000

/** 选中行最大字节数（readMaxBytes 默认）。 */
export const READ_MAX_BYTES = 50 * 1024

/** 一个解析后的读窗口。 */
export interface ReadWindow {
  /** 1-based 首行。 */
  offset: number
  /** 最大返回行数。 */
  limit: number
  /** 单行最大字符数；超长截断加后缀。 */
  maxLineLength: number
  /** 选中输出最大字节数；超限停止收行并标记 truncatedByBytes。 */
  maxBytes: number
}

/** 文件的一行。 */
export interface FileTextLine {
  /** 文件中的 1-based 行号。 */
  number: number
  /** 不含行尾换行的文本。 */
  text: string
}

/** buildWindow 的结果。 */
export interface WindowResult {
  lines: FileTextLine[]
  /** 文件的精确总行数。 */
  totalLines: number
  /** 选中输出是否撞上字节预算。 */
  truncatedByBytes: boolean
}

/** formatReadOutput 的输入。 */
export interface FileReadOutcome {
  offset: number
  lines: FileTextLine[]
  totalLines: number
  truncatedByBytes?: true
}

interface WindowAccumulator {
  lines: FileTextLine[]
  totalLines: number
  outputBytes: number
  truncatedByBytes: boolean
}

function newAccumulator(): WindowAccumulator {
  return { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false }
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)` : line
}

/** 一行文本的字节数 + 行间 \n 分隔符（首行除外）。 */
function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0)
}

function consumeLine(acc: WindowAccumulator, rawLine: string, request: ReadWindow): void {
  acc.totalLines += 1
  if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit) return

  const text = truncateLine(rawLine, request.maxLineLength)
  const bytes = lineByteSize(text, acc.lines.length)
  if (acc.outputBytes + bytes > request.maxBytes) {
    acc.truncatedByBytes = true
    return
  }
  acc.outputBytes += bytes
  acc.lines.push({ number: acc.totalLines, text })
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function finish(acc: WindowAccumulator, request: ReadWindow, displayPath: string): WindowResult {
  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new DiverFsError(`offset ${request.offset} is out of range for "${displayPath}" (${acc.totalLines} lines)`, 'FS_NOT_FOUND')
  }
  return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes }
}

/**
 * 从流式或整文件块构建一个窗口，执行行数与字节上限的同时仍扫描出精确总行数；
 * 请求的 offset 越过 EOF 时抛 FS_NOT_FOUND。
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindow,
  displayPath: string,
): Promise<WindowResult> {
  const acc = newAccumulator()
  // 只需超过截断点 1 个字符即可证明行超长。
  const lineBufferCap = request.maxLineLength + 1
  let lineBuffer = ''

  function appendToLineBuffer(segment: string): void {
    if (lineBuffer.length >= lineBufferCap) return
    lineBuffer += segment
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap)
  }

  function flushLine(): void {
    consumeLine(acc, stripCarriageReturn(lineBuffer), request)
    lineBuffer = ''
  }

  for await (const chunk of chunks) {
    let startPos = 0
    let newlinePos: number
    while ((newlinePos = chunk.indexOf('\n', startPos)) !== -1) {
      appendToLineBuffer(chunk.slice(startPos, newlinePos))
      flushLine()
      startPos = newlinePos + 1
    }
    appendToLineBuffer(chunk.slice(startPos))
  }
  if (lineBuffer.length > 0) flushLine()
  return finish(acc, request, displayPath)
}

/** 把一次读取渲染成 OpenCode 风格的行号文本块 body。 */
export function formatReadOutput(displayPath: string, outcome: FileReadOutcome): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1)
  let footer: string
  if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`
  }
  const body = outcome.lines.length > 0
    ? `${outcome.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}`
    : footer
  return `<path>${displayPath}</path>
<type>file</type>
<content>
${body}
</content>`
}
