// @diver/basic-tools — 移植自 DSH 上游 @deepseek-ai/dsh-fs-local 的本地文件系统基础层
// （Cordis-free 纯 node:fs，无 ctx.fs 服务依赖）。
//
// 与上游的差异（diver 是 Windows 桌面 companion，无沙箱/观测服务）：
// - 错误用 DiverFsError（带稳定 code）而非上游 FsError 词表，message 即模型可见文案；
// - Windows 原子发布简化：rename 覆盖 + chmod 保 mode（上游用 koffi 复制 DACL +
//   ReplaceFileW，普通文本文件场景非必需，避免引入 native 依赖）；
// - 无 fs/observed 观测事件与 fs/write-intent waterfall：守卫语义由调用方
//   （observation 表）实现。

import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat,
} from 'node:fs/promises'
import type { BigIntStats, Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'

/** 二进制采样字节数：read/stream 读前 8192 字节查 NUL 判二进制。 */
export const BINARY_SAMPLE_BYTES = 8192

/** 一次不可中止 FileHandle.read 的分块上限，保证取消在块间被观察到。 */
const DIFF_BASIS_READ_CHUNK_BYTES = 64 * 1024

/** 稳定的文件操作错误码（上游 FsErrorCode 的简化子集）。 */
export type DiverFsErrorCode =
  | 'FS_NOT_FOUND'
  | 'FS_NOT_REGULAR_FILE'
  | 'FS_NOT_DIRECTORY'
  | 'FS_NOT_TEXT'
  | 'FS_TOO_LARGE'
  | 'FS_STALE_VERSION'
  | 'FS_NOT_OBSERVED'
  | 'FS_EDIT_NOT_FOUND'
  | 'FS_AMBIGUOUS_EDIT'
  | 'FS_PERMISSION_DENIED'
  | 'FS_IO_ERROR'
  | 'FS_ABORTED'

/** 文件操作错误：message 即模型可见文案，code 供上层分支。 */
export class DiverFsError extends Error {
  override readonly name = 'DiverFsError'
  readonly code: DiverFsErrorCode

  constructor(message: string, code: DiverFsErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.code = code
  }
}

function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isENOTDIR(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOTDIR'
}

function isEEXIST(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM')
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) throw new DiverFsError(`${verb} aborted`, 'FS_ABORTED')
}

/** 带 signal 的 readFile，把 AbortError 翻译成结构化错误。 */
async function readFileAbortable(absolutePath: string, verb: 'read' | 'edit', signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readFile(absolutePath, signal ? { signal } : {})
  } catch (error: unknown) {
    if (!isAbortError(error)) throw error
    throw new DiverFsError(`${verb} aborted`, 'FS_ABORTED')
  }
}

// ─── 解析与探测 ────────────────────────────────────────────────────────────

/** 解析后的本地路径：展示用绝对路径 + 身份用的 realpath 键。 */
export interface LocalTarget {
  /** 绝对路径（不解析符号链接）——用于展示。 */
  displayPath: string
  /** realpath 身份——用于稳定目标键与 I/O 路径。 */
  targetKey: string
}

/** 探测结果；null 表示不存在。 */
export interface PathInfo {
  version: string
  mode: number
  type: 'file' | 'directory' | 'other'
  size: number
}

/** Opaque 版本令牌：高精度身份与新鲜度元数据。 */
function versionOf(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/**
 * 解析路径为绝对展示路径 + realpath 身份。目标缺失时 realpath 最近存在的
 * 祖先并回填缺失后缀，保证创建前后身份稳定（含符号链接祖先）。
 */
export async function resolveLocalTarget(cwd: string, path: string): Promise<LocalTarget> {
  if (path.trim().length === 0) throw new DiverFsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const displayPath = resolve(cwd, path)
  try {
    return { displayPath, targetKey: await realpath(displayPath) }
  } catch (error: unknown) {
    if (isENOTDIR(error)) {
      throw new DiverFsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
    }
    if (!isENOENT(error)) throw error
  }
  // 文件缺失：realpath 最近存在的祖先，回填缺失后缀。
  const missing = [basename(displayPath)]
  let ancestor = dirname(displayPath)
  while (true) {
    try {
      const realAncestor = await realpath(ancestor)
      if (process.platform === 'win32') {
        const parentInfo = await stat(realAncestor)
        if (!parentInfo.isDirectory()) {
          throw new DiverFsError(`cannot resolve "${displayPath}": a parent path segment is not a directory`, 'FS_NOT_FOUND')
        }
      }
      return { displayPath, targetKey: join(realAncestor, ...missing) }
    } catch (error: unknown) {
      if (error instanceof DiverFsError) throw error
      if (!isENOENT(error)) throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) return { displayPath, targetKey: displayPath }
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
}

function pathType(info: Stats | BigIntStats): PathInfo['type'] {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

async function probeStats<T extends Stats | BigIntStats>(
  absolutePath: string,
  readStats: (path: string) => Promise<T>,
): Promise<T | null> {
  try {
    return await readStats(absolutePath)
  } catch (error: unknown) {
    if (!isENOENT(error) && !isENOTDIR(error)) throw error
    return null
  }
}

/** 探测路径的版本/模式/类型/大小；不存在（含父级为文件）时返回 null。 */
export async function probe(absolutePath: string): Promise<PathInfo | null> {
  const info = await probeStats(absolutePath, path => stat(path, { bigint: true }))
  if (!info) return null
  return {
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
    type: pathType(info),
    size: Number(info.size),
  }
}

/** 不跟随最终符号链接的探测。 */
export async function probeNoFollow(absolutePath: string): Promise<PathInfo | null> {
  const info = await probeStats(absolutePath, path => lstat(path, { bigint: true }))
  if (!info) return null
  return {
    version: versionOf(info),
    mode: Number(info.mode & 0o777n),
    type: pathType(info),
    size: Number(info.size),
  }
}

// ─── 读取 ──────────────────────────────────────────────────────────────────

function notTextError(verb: 'read' | 'edit', displayPath: string): DiverFsError {
  return new DiverFsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
}

function decodeUtf8(buffer: Uint8Array, verb: 'read' | 'edit', displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

function decodeUtf8Stream(
  decoder: TextDecoder,
  chunk: Uint8Array | undefined,
  verb: 'read' | 'edit',
  displayPath: string,
): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode()
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

async function statRegularFile(target: LocalTarget, verb: 'read', signal?: AbortSignal): Promise<Stats> {
  throwIfAborted(signal, verb)
  let info: Stats
  try {
    info = await stat(target.targetKey)
  } catch (error: unknown) {
    if (!isENOENT(error)) throw error
    throw new DiverFsError(`cannot ${verb} "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (!info.isFile()) throw new DiverFsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return info
}

/** 整体读取一个常规 UTF-8 文本文件；拒绝非常规文件、非法 UTF-8 与 NUL 二进制采样。 */
export async function readWholeText(target: LocalTarget, signal?: AbortSignal): Promise<string> {
  await statRegularFile(target, 'read', signal)
  const raw = await readFileAbortable(target.targetKey, 'read', signal)
  throwIfAborted(signal, 'read')
  if (raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new DiverFsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  return decodeUtf8(raw, 'read', target.displayPath)
}

/** 以解码文本块流式读取整个常规 UTF-8 文本文件；语义同 readWholeText，但不整文件驻留内存。 */
export async function* streamWholeText(target: LocalTarget, signal?: AbortSignal): AsyncIterable<string> {
  await statRegularFile(target, 'read', signal)
  const stream = createReadStream(target.targetKey, signal ? { signal } : {})
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let sampledBytes = 0

  function scanBinarySample(chunk: Buffer): void {
    if (sampledBytes >= BINARY_SAMPLE_BYTES) return
    const sample = chunk.subarray(0, Math.min(chunk.length, BINARY_SAMPLE_BYTES - sampledBytes))
    if (sample.includes(0)) {
      throw new DiverFsError(`cannot read "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
    }
    sampledBytes += sample.length
  }

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      scanBinarySample(chunk)
      yield decodeUtf8Stream(decoder, chunk, 'read', target.displayPath)
    }
    yield decodeUtf8Stream(decoder, undefined, 'read', target.displayPath)
  } catch (error: unknown) {
    if (isAbortError(error)) throw new DiverFsError('read aborted', 'FS_ABORTED')
    throw error
  }
}

// ─── 写入（原子发布）───────────────────────────────────────────────────────

async function removeStagingDirOrThrow(
  stagingDir: string,
  originalError: unknown,
  removeStagingDir: (path: string) => Promise<void>,
): Promise<never> {
  try {
    await removeStagingDir(stagingDir)
  } catch (cleanupError: unknown) {
    throw new DiverFsError(
      `write failed (${errorMessage(originalError)}) and temp cleanup failed (${errorMessage(cleanupError)})`,
      'FS_NOT_FOUND',
      { cause: originalError },
    )
  }
  throw originalError
}

async function throwGuardedCreateFailure(
  error: unknown,
  absolutePath: string,
  displayPath: string,
  inspectPublicationTarget: (path: string) => Promise<BigIntStats>,
): Promise<never> {
  let existing: BigIntStats | undefined
  try {
    existing = await inspectPublicationTarget(absolutePath)
  } catch (metadataError: unknown) {
    if (!isENOENT(metadataError) && !isENOTDIR(metadataError)) {
      throw new DiverFsError(`cannot write "${displayPath}": ${errorMessage(metadataError)}`, 'FS_IO_ERROR', { cause: metadataError })
    }
  }
  if (existing !== undefined) {
    if (!existing.isFile()) {
      throw new DiverFsError(`cannot write "${displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE', { cause: error })
    }
    throw new DiverFsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    )
  }
  if (isEEXIST(error)) {
    throw new DiverFsError(
      `cannot overwrite existing "${displayPath}" without reading it first`,
      'FS_NOT_OBSERVED',
      { cause: error },
    )
  }
  throw new DiverFsError(`cannot write "${displayPath}": ${errorMessage(error)}`, 'FS_IO_ERROR', { cause: error })
}

/**
 * 通过同目录私有、已 sync 的 staging 文件原子替换目标文件。
 * staging 目录与文件以 0o700 / 0o600 创建；Windows 覆盖用 rename（Node 的
 * rename 在 Windows 上即 MoveFileEx 覆盖语义），有既有 mode 时保留。
 */
export async function writeFileAtomic(
  absolutePath: string,
  content: string,
  mode: number | undefined,
  signal: AbortSignal | undefined,
  createIfAbsent?: { displayPath: string },
): Promise<void> {
  throwIfAborted(signal, 'write')
  const directory = dirname(absolutePath)
  await mkdir(directory, { recursive: true })

  throwIfAborted(signal, 'write')
  const stagingDirName = `.${basename(absolutePath)}.${process.pid}.${randomUUID()}.tmpdir`
  const stagingDir = join(directory, stagingDirName)
  const tempPath = join(stagingDir, `${basename(absolutePath)}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let stagingCreated = false
  try {
    await mkdir(stagingDir, { mode: 0o700 })
    stagingCreated = true
    await chmod(stagingDir, 0o700)

    handle = await open(tempPath, 'wx', 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(content, { encoding: 'utf8', ...signal ? { signal } : {} })
    await handle.sync()
    if (mode !== undefined) await handle.chmod(mode)
    await handle.close()
    handle = undefined

    throwIfAborted(signal, 'write')
    if (createIfAbsent !== undefined) {
      try {
        await link(tempPath, absolutePath)
      } catch (error: unknown) {
        await throwGuardedCreateFailure(
          error,
          absolutePath,
          createIfAbsent.displayPath,
          path => lstat(path, { bigint: true }),
        )
      }
    } else {
      await rename(tempPath, absolutePath)
    }
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } catch (_committedStagingCleanupFailure) {
      // 目标已提交；owner-only staging 残留不应把这次写入变成失败。
    }
  } catch (error: unknown) {
    let failure: unknown = isAbortError(error) ? new DiverFsError('write aborted', 'FS_ABORTED') : error
    if (handle) {
      try {
        await handle.close()
      } catch (closeError: unknown) {
        failure = new DiverFsError(
          `write failed (${errorMessage(failure)}) and temp close failed (${errorMessage(closeError)})`,
          'FS_NOT_FOUND',
          { cause: failure },
        )
      }
    }
    if (!stagingCreated) throw failure
    return removeStagingDirOrThrow(stagingDir, failure, path => rm(path, { recursive: true, force: true }))
  }
}

// ─── 编辑 ──────────────────────────────────────────────────────────────────

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
  if (buffer.includes(0)) throw new DiverFsError(`cannot edit "${displayPath}": binary file`, 'FS_NOT_TEXT')
  const raw = decodeUtf8(buffer, 'edit', displayPath)
  return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) }
}

/**
 * 对 LF 归一内容做字面替换。空/缺失搜索文本抛 FS_EDIT_NOT_FOUND；多匹配且
 * 非 replaceAll 抛 FS_AMBIGUOUS_EDIT。
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new DiverFsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new DiverFsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && replacements > 1) {
    throw new DiverFsError(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}
