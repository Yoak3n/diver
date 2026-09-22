// @diver/basic-tools — find 工具：按 glob 找文件（对标 pi find.ts）。
// 纯 Node 递归遍历，不依赖 fd；忽略 node_modules/.git；相对路径 posix 输出。

import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Context } from 'cordis'

import { DiverFsError, probe, resolveLocalTarget } from './fsio.ts'
import { formatSize, truncateHead } from './truncate.ts'

export interface FindCaps {
  workspaceRoot: string
}

export const FIND_DEFAULT_LIMIT = 1000
const IGNORED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'target', '.cos-home'])

interface FindArgs {
  pattern: string
  path?: string
  limit?: number
}

/**
 * glob → RegExp。支持 `*`（段内）、`**`（跨段）、`?`。
 * 匹配相对 searchRoot 的 posix 路径；大小写不敏感（Windows 友好）。
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let re = ''
  let i = 0
  while (i < normalized.length) {
    const c = normalized[i]
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          re += '(?:[^/]+/)*'
          i += 3
        } else {
          re += '.*'
          i += 2
        }
      } else {
        re += '[^/]*'
        i += 1
      }
    } else if (c === '?') {
      re += '[^/]'
      i += 1
    } else if ('.+^$()[]{}|\\'.includes(c)) {
      re += `\\${c}`
      i += 1
    } else {
      re += c
      i += 1
    }
  }
  return new RegExp(`^${re}$`, 'i')
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/** 递归收集匹配文件（相对 posix 路径）。 */
export async function walkGlob(
  searchRoot: string,
  pattern: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const re = globToRegExp(pattern)
  const hits: string[] = []

  async function walk(dir: string): Promise<void> {
    if (hits.length >= limit) return
    if (signal?.aborted) throw new DiverFsError('aborted', 'FS_ABORTED')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (hits.length >= limit) return
      if (signal?.aborted) throw new DiverFsError('aborted', 'FS_ABORTED')
      if (IGNORED_DIRS.has(name)) continue
      const full = join(dir, name)
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      const rel = toPosix(relative(searchRoot, full))
      if (info.isDirectory()) {
        // 目录名也可能被 `**/foo/` 类模式命中，但 find 只报文件。
        await walk(full)
      } else if (info.isFile()) {
        if (re.test(rel)) hits.push(rel)
      }
    }
  }

  await walk(searchRoot)
  hits.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  return hits
}

export function applyFindTool(ctx: Context, caps: FindCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:find',
    order: 107,
    text: 'Use the find tool to locate files by glob (e.g. "*.ts", "**/*.json", "src/**/*.spec.ts"). Returns paths relative to the search directory. Prefer find over sh for file discovery; use grep for content search.',
  })

  ctx.tools.register('find', async (args, signal) => {
    const input = args as FindArgs
    if (!input || typeof input.pattern !== 'string' || input.pattern.trim().length === 0) {
      throw new DiverFsError('pattern must be a non-empty string', 'FS_NOT_FOUND')
    }
    const rawPath = (input.path ?? '.').trim() || '.'
    const limit = Number(input.limit) > 0 ? Math.floor(Number(input.limit)) : FIND_DEFAULT_LIMIT
    const target = await resolveLocalTarget(caps.workspaceRoot, rawPath)
    const info = await probe(target.targetKey)
    if (info === null) {
      throw new DiverFsError(`Path not found: ${target.displayPath}`, 'FS_NOT_FOUND')
    }
    if (info.type !== 'directory') {
      throw new DiverFsError(`Not a directory: ${target.displayPath}`, 'FS_NOT_FOUND')
    }

    const hits = await walkGlob(target.targetKey, input.pattern.trim(), limit, signal)
    if (hits.length === 0) return { content: 'No files found matching pattern' }

    const resultLimitReached = hits.length >= limit
    const truncation = truncateHead(hits.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
    let output = truncation.content
    const notices: string[] = []
    if (resultLimitReached) {
      notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`)
    }
    if (truncation.truncated) {
      notices.push(`${formatSize(truncation.maxBytes)} limit reached`)
    }
    if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`
    return { content: output }
  }, {
    description:
      'Search for files by glob pattern (e.g. "**/*.ts"). Returns matching paths relative to the search directory. Ignores node_modules/.git. Truncated to 1000 results or 50KB.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "*.ts", "**/*.json", "src/**/*.spec.ts".' },
        path: { type: 'string', description: 'Directory to search in (default: workspace root ".").' },
        limit: { type: 'number', description: 'Maximum results (default 1000).' },
      },
      required: ['pattern'],
    },
  })
}
