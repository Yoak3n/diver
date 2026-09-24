// @diver/basic-tools — read 工具：UTF-8 文本按行读取；图片文件返回多模态图片块
// （模型可直接「看」截图/插图）。窗口读取、字节预算、流式大文件、二进制拒绝
// 对齐 DSH 上游；输出 OpenCode 风格带行号 envelope。

import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Context } from 'cordis'

import { DiverFsError, resolveLocalTarget, streamWholeText, readWholeText } from './fsio.ts'
import type { LocalTarget } from './fsio.ts'
import { buildWindow, formatReadOutput } from './read-render.ts'
import type { ObservationTable } from './observation.ts'

/** 默认/最大行数。 */
export const READ_LIMIT = 2000

/** 达到此大小流式读取（避免整文件缓冲）。 */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

/** 单行最大字符数。 */
export const READ_MAX_LINE_LENGTH = 2000

/** 选中行最大字节数。 */
export const READ_MAX_BYTES = 50 * 1024

/** 图片读取上限（base64 后约 1.33×，须控制上下文体积）。 */
const IMAGE_MAX_BYTES = 4 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

function imageMimeOf(path: string): string | null {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? null
}

export interface ReadCaps {
  workspaceRoot: string
  /** 本会话观察表（read-first 守卫用）。 */
  observation: ObservationTable
}

interface ReadArgs {
  file_path: string
  offset?: number
  limit?: number
}

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/** 校验参数并应用默认值（limit 默认与上限均为 READ_LIMIT）。 */
function parseReadArgs(args: ReadArgs): { filePath: string; offset: number; limit: number } {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? READ_LIMIT : parsePositiveInteger(args.limit, 'limit')
  if (limit > READ_LIMIT) throw new Error(`limit must be less than or equal to ${READ_LIMIT}`)
  return { filePath: args.file_path.trim(), offset, limit }
}

/** 解析目标并 stat 一次：检查存在性与常规文件。 */
async function resolveRegularReadTarget(
  workspaceRoot: string,
  filePath: string,
): Promise<{ target: LocalTarget; size: number | undefined }> {
  const target = await resolveLocalTarget(workspaceRoot, filePath)
  let info
  try {
    info = await stat(target.targetKey)
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    throw new DiverFsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
  }
  if (!info.isFile()) throw new DiverFsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  return { target, size: info.size }
}

/** 图片文件：整读为 base64 图片块，让多模态模型直接看到画面。 */
async function readImageResult(target: LocalTarget, size: number | undefined) {
  const tooLarge = (n: number) =>
    new DiverFsError(
      `cannot read "${target.displayPath}": image too large (${n} bytes; max ${IMAGE_MAX_BYTES}). ` +
        'Next steps: use the screenshot tool (JPEG, region crop) to produce a small file, or crop/downscale this file first. Do not attempt to read raw bytes.',
      'FS_NOT_TEXT',
    )
  if (size !== undefined && size > IMAGE_MAX_BYTES) throw tooLarge(size)
  const raw = await readFile(target.targetKey)
  if (raw.length > IMAGE_MAX_BYTES) throw tooLarge(raw.length)
  const mime = imageMimeOf(target.targetKey) ?? imageMimeOf(target.displayPath) ?? 'image/png'
  const data = raw.toString('base64')
  const name = target.displayPath.split(/[\\/]/).pop() ?? target.displayPath
  const content =
    `Read image "${target.displayPath}" (${mime}, ${raw.length} bytes). ` +
    `The image is attached as a multimodal block for visual inspection — describe what you see.`
  return {
    content,
    images: [{ mime, data, name }],
  }
}

/** 注册 read 工具。 */
export function applyReadTool(ctx: Context, caps: ReadCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: 100,
    text:
      'Use the read tool — not shell commands like cat — to inspect text files. Results include line numbers. ' +
      'Use offset and limit to continue reading large files. ' +
      'For image files (png/jpg/webp/gif/bmp), read returns the actual image so you can see it — use this after taking screenshots. Absolute paths are allowed (e.g. Temp screenshots).',
  })

  ctx.tools.register('read', async (args, signal) => {
    const input = parseReadArgs(args as ReadArgs)

    const { target, size } = await resolveRegularReadTarget(caps.workspaceRoot, input.filePath)

    // 图片：多模态直读（截图/插图），不再当二进制拒掉
    const mime = imageMimeOf(target.targetKey) ?? imageMimeOf(target.displayPath)
    if (mime) {
      const result = await readImageResult(target, size)
      try {
        const observed = await stat(target.targetKey, { bigint: true })
        caps.observation.markObserved(target.targetKey, `${observed.dev}:${observed.ino}:${observed.size}:${observed.mtimeNs}:${observed.ctimeNs}`)
      } catch {
        /* 并发删除等竞态：观察失败不阻断本次已成功的读 */
      }
      return result
    }

    // 文件大或尺寸未知时流式，避免整文件缓冲。
    const chunks = size === undefined || size >= STREAM_MIN_SIZE
      ? streamWholeText(target, signal)
      : [await readWholeText(target, signal)]
    const window = await buildWindow(
      chunks,
      { offset: input.offset, limit: input.limit, maxLineLength: READ_MAX_LINE_LENGTH, maxBytes: READ_MAX_BYTES },
      target.displayPath,
    )

    // read-first 守卫：记录观察版本。
    try {
      const observed = await stat(target.targetKey, { bigint: true })
      caps.observation.markObserved(target.targetKey, `${observed.dev}:${observed.ino}:${observed.size}:${observed.mtimeNs}:${observed.ctimeNs}`)
    } catch {
      // 并发删除等竞态：观察失败不阻断本次已成功的读。
    }

    return { content: formatReadOutput(target.displayPath, {
      offset: input.offset,
      lines: window.lines,
      totalLines: window.totalLines,
      ...window.truncatedByBytes ? { truncatedByBytes: true as const } : {},
    }) }
  }, {
    description:
      'Read a file. Text: line-numbered UTF-8 content. Images (png/jpg/webp/gif/bmp): returns the image for visual inspection (screenshots, figures). Absolute paths allowed.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to read; relative paths resolve against the workspace root. Absolute paths (e.g. Temp screenshots) are allowed.' },
        offset: { type: 'number', description: '1-based first line to return (text only). Defaults to 1.' },
        limit: { type: 'number', description: `Maximum number of lines to return (text only). Defaults to ${READ_LIMIT}.` },
      },
      required: ['file_path'],
    },
  })
}
