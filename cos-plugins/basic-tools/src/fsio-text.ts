// @diver/basic-tools — 文件系统基础层：文本解码与二进制拒绝（read / edit 共用原语）。

import { readFile } from 'node:fs/promises'
import { TextDecoder } from 'node:util'

import { DiverFsError, isAbortError } from './fsio-error.ts'

/** 二进制采样字节数：read/stream 读前 8192 字节查 NUL 判二进制。 */
export const BINARY_SAMPLE_BYTES = 8192

/** 二进制拒绝时给模型的下一步指引（减少「反复 cat / 以为自己能看」的死循环）。 */
export const BINARY_GUIDANCE =
  'Next steps: ' +
  '(1) If this is an image (png/jpg/jpeg/webp/gif/bmp), call read on that path — read returns the image as a multimodal block you can see. ' +
  '(2) If it is another binary (pdf/zip/exe/audio/video/office), do not cat or print raw bytes. Use sh with type-specific tools (e.g. file, unzip -l, pdfinfo) for metadata only, or ask the user to export/convert to text/image first. ' +
  '(3) Use ls/find to confirm the file type before choosing a tool.'

function notTextError(verb: 'read' | 'edit', displayPath: string): DiverFsError {
  return new DiverFsError(
    `cannot ${verb} "${displayPath}": invalid UTF-8 text. ` +
      `This is not plain text — do not retry read/edit on it. ` +
      BINARY_GUIDANCE,
    'FS_NOT_TEXT',
  )
}

export function decodeUtf8(buffer: Uint8Array, verb: 'read' | 'edit', displayPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error
    throw notTextError(verb, displayPath)
  }
}

export function decodeUtf8Stream(
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

/** 带 signal 的 readFile，把 AbortError 翻译成结构化错误。 */
export async function readFileAbortable(absolutePath: string, verb: 'read' | 'edit', signal?: AbortSignal): Promise<Buffer> {
  try {
    return await readFile(absolutePath, signal ? { signal } : {})
  } catch (error: unknown) {
    if (!isAbortError(error)) throw error
    throw new DiverFsError(`${verb} aborted`, 'FS_ABORTED')
  }
}
