// @diver/basic-tools — 文件系统基础层：编辑（行尾归一 + 字面替换）。

import { findEditMatch } from './edit-match.ts'
import { DiverFsError, throwIfAborted } from './fsio-error.ts'
import { BINARY_GUIDANCE, decodeUtf8, readFileAbortable } from './fsio-text.ts'

/** 编辑前检测到的行尾风格。 */
export type LineEndings = 'LF' | 'CRLF'

/** 把 CRLF 折叠为 LF——所有编辑/diff 基准的规范内存形态；孤立 \r 不动。 */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/** 把 LF 归一内容还原为读取时检测到的行尾风格；CRLF 先归一避免 \r\r\n。 */
export function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/** 读取并解码一个待编辑文件：拒绝二进制，返回 LF 归一内容 + 原始行尾风格。 */
export async function readForEdit(
  absolutePath: string,
  displayPath: string,
  signal?: AbortSignal,
): Promise<{ content: string; lineEndings: LineEndings }> {
  throwIfAborted(signal, 'edit')
  const buffer = await readFileAbortable(absolutePath, 'edit', signal)
  throwIfAborted(signal, 'edit')
  if (buffer.includes(0)) {
    throw new DiverFsError(
      `cannot edit "${displayPath}": binary file. ` + BINARY_GUIDANCE,
      'FS_NOT_TEXT',
    )
  }
  const raw = decodeUtf8(buffer, 'edit', displayPath)
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/**
 * 对 LF 归一内容做字面替换。空/缺失搜索文本抛 FS_EDIT_NOT_FOUND；多匹配且
 * 非 replaceAll 抛 FS_AMBIGUOUS_EDIT。
 * exact 失败时走 edit-match 分层模糊（引号/行号前缀/行内空白/缩进），命中后
 * 用文件里的真实片段做替换。
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number; actualString: string; matchStrategy: string } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new DiverFsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const newNorm = normalizeLineEndings(newString)
  const match = findEditMatch({ content, search: oldNorm, replaceAll })
  if (match.status === 'not_found') {
    throw new DiverFsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (match.status === 'ambiguous') {
    throw new DiverFsError(
      `old_string matched ${match.candidateCount} times in "${displayPath}" (strategy=${match.strategy}); provide a more specific old_string or set replace_all to true`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  const needle = match.actualString
  const replacements = countOccurrences(content, needle)
  if (replacements === 0) {
    throw new DiverFsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && replacements > 1) {
    throw new DiverFsError(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  return { content: content.split(needle).join(newNorm), replacements, actualString: needle, matchStrategy: match.strategy }
}
