// @diver/basic-tools — ls 工具：列目录（对标 pi ls.ts）。
// 字母序、目录带 / 后缀、含点文件；条目数与字节双限额。

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from 'cordis'

import { DiverFsError, resolveLocalTarget } from './fsio.ts'
import { formatSize, truncateHead } from './truncate.ts'

export interface LsCaps {
  workspaceRoot: string
}

export const LS_DEFAULT_LIMIT = 500

interface LsArgs {
  path?: string
  limit?: number
}

/** 列出目录条目（导出供 smoke / find 复用）。 */
export async function listDirectory(
  absolutePath: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ entries: string[]; entryLimitReached: boolean }> {
  let names: string[]
  try {
    names = await readdir(absolutePath)
  } catch (error) {
    throw new DiverFsError(
      `cannot read directory "${absolutePath}": ${(error as Error).message}`,
      'FS_NOT_FOUND',
    )
  }
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  const entries: string[] = []
  let entryLimitReached = false
  for (const name of names) {
    if (signal?.aborted) throw new DiverFsError('aborted', 'FS_ABORTED')
    if (entries.length >= limit) {
      entryLimitReached = true
      break
    }
    try {
      const info = await stat(join(absolutePath, name))
      entries.push(info.isDirectory() ? `${name}/` : name)
    } catch {
      continue
    }
  }
  return { entries, entryLimitReached }
}

export function applyLsTool(ctx: Context, caps: LsCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:ls',
    order: 108,
    text: 'Use the ls tool to list a directory before diving in. Entries are alphabetical; directories end with "/". Prefer ls + read/grep over sh for simple navigation.',
  })

  ctx.tools.register('ls', async (args, signal) => {
    const input = (args ?? {}) as LsArgs
    const rawPath = (input.path ?? '.').trim() || '.'
    const limit = Number(input.limit) > 0 ? Math.floor(Number(input.limit)) : LS_DEFAULT_LIMIT
    const target = await resolveLocalTarget(caps.workspaceRoot, rawPath)
    const probe = await import('./fsio.ts').then((m) => m.probe(target.targetKey))
    if (probe === null) {
      throw new DiverFsError(`Path not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    }
    if (probe.type !== 'directory') {
      throw new DiverFsError(`Not a directory: ${target.displayPath}`, 'FS_NOT_FOUND')
    }
    const { entries, entryLimitReached } = await listDirectory(target.targetKey, limit, signal)
    if (entries.length === 0) return { content: '(empty directory)' }

    const truncation = truncateHead(entries.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
    let output = truncation.content
    const notices: string[] = []
    if (entryLimitReached) {
      notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`)
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(truncation.maxBytes)} limit reached`)
    }
    if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`
    return { content: output }
  }, {
    description:
      'List directory contents, sorted alphabetically. Directories get a trailing "/". Includes dotfiles. Truncated to 500 entries or 50KB.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list (default: workspace root ".").' },
        limit: { type: 'number', description: 'Maximum entries (default 500).' },
      },
    },
  })
}
