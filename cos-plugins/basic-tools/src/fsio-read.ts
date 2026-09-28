// @diver/basic-tools — 文件系统基础层：常规文本文件读取（整体 / 流式）。

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { TextDecoder } from 'node:util'

import { DiverFsError, isAbortError, isENOENT, throwIfAborted } from './fsio-error.ts'
import {
  BINARY_GUIDANCE, BINARY_SAMPLE_BYTES, decodeUtf8, decodeUtf8Stream, readFileAbortable,
} from './fsio-text.ts'
import type { LocalTarget } from './fsio-target.ts'

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
    throw new DiverFsError(
      `cannot read "${target.displayPath}": binary file. ` + BINARY_GUIDANCE,
      'FS_NOT_TEXT',
    )
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
      throw new DiverFsError(
        `cannot read "${target.displayPath}": binary file. ` + BINARY_GUIDANCE,
        'FS_NOT_TEXT',
      )
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
