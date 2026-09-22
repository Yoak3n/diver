// @diver/basic-tools — grep 工具：文件内容搜索（Rust 后端）。
//
// 引擎在 Rust 壳（src-tauri/services/rpc.rs 的 grep::search 方法，ripgrep 引擎），
// Node 侧经现有本地 HTTP RPC 通道调用（与 @diver/memory 同一条
// 127.0.0.1:{DIVER_MEMORY_PORT}/rpc 通道）。
//
// 接口与 DSH 上游 @deepseek-ai/dsh-tool-fs-search/grep 对齐：
// - pattern: ripgrep 正则；path: 目标文件或目录（默认 workspace 根）；
// - include(s)/exclude(s): rg glob（支持 `{a,b}` 与 `!` 否定；exclude 自动加 `!`）；
// - maxCount: 保留的最大匹配数（默认 250）。
// - 返回按文件分组的 `Line N: <text>`，超限时提示收窄。
//
// 结果渲染（formatGrepMatches）与上游一致：每文件一段 `path\nLine N: text`。

import type { Context } from 'cordis'
import { nativeRpc } from '@diver/native-bridge/rpc'

/** 默认保留在结果里的最大匹配数（与上游 GREP_MAX_MATCHES 一致）。 */
export const GREP_MAX_MATCHES = 250

/** 单行预览的最大字节数（与上游 GREP_MAX_LINE_BYTES 一致）。 */
export const GREP_MAX_LINE_BYTES = 2000

export interface GrepCaps {
  workspaceRoot: string
}

interface GrepArgs {
  pattern: string
  path?: string
  /** rg glob；字符串或数组。支持 `{a,b}` 与 `!` 否定。 */
  include?: string | string[]
  /** 与 include 同义的列表形式。 */
  includes?: string[]
  /** 排除 glob（自动加 `!`）；字符串或数组。 */
  exclude?: string | string[]
  /** 保留的最大匹配数（默认 250）。 */
  maxCount?: number
}

interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

function asGlobList(value: string | string[] | undefined, field: string): string[] {
  if (value === undefined) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((item) => {
    if (item.trim().length === 0) throw new Error(`${field} must be a non-empty glob when given`)
    return item.trim()
  })
}

/** 校验并归一化参数：include(s) 原样、exclude(s) 自动加 `!`。 */
export function parseGrepArgs(args: GrepArgs): {
  pattern: string
  path?: string
  globs: string[]
  maxCount?: number
} {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')

  const globs = [
    ...asGlobList(args.include, 'include'),
    ...asGlobList(args.includes, 'includes'),
    ...asGlobList(args.exclude, 'exclude').map((g) => (g.startsWith('!') ? g : `!${g}`)),
  ]

  const maxCount = args.maxCount !== undefined ? Number(args.maxCount) : undefined
  if (maxCount !== undefined && (!Number.isFinite(maxCount) || maxCount <= 0)) {
    throw new Error('maxCount must be a positive integer when given')
  }

  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    globs,
    ...maxCount !== undefined ? { maxCount: Math.floor(maxCount) } : {},
  }
}

/** 本地 RPC 通道（统一经 @diver/native-bridge）。 */
async function rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return nativeRpc<T>(method, params, { label: `grep:${method}` })
}

/** 单行预览按字节截断（UTF-8 边界安全），超长加后缀。 */
function previewLine(line: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(line, 'utf8')
  if (bytes <= maxBytes) return line
  let end = 0
  let count = 0
  while (end < line.length && count < maxBytes) {
    const codePoint = line.codePointAt(end)!
    const width = codePoint > 0xffff ? 2 : 1
    const charBytes = Buffer.byteLength(line.slice(end, end + width), 'utf8')
    if (count + charBytes > maxBytes) break
    count += charBytes
    end += width
  }
  return `${line.slice(0, end)}... (line truncated)`
}

/** 按文件分组渲染匹配（与上游 formatGrepMatches 对齐）。 */
function formatGrepMatches(matches: Array<{ path: string; lineNumber: number; line: string }>): string {
  const byFile = new Map<string, Array<{ lineNumber: number; line: string }>>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push({ lineNumber: match.lineNumber, line: match.line })
    else byFile.set(match.path, [{ lineNumber: match.lineNumber, line: match.line }])
  }
  const sections: string[] = []
  for (const [path, group] of byFile) {
    sections.push(`${path}\n${group.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

/** 注册 grep 工具。 */
export function applyGrepTool(ctx: Context, caps: GrepCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:grep',
    order: 104,
    text: 'Use the grep tool — not shell grep or rg — to search file contents. Narrow with include/exclude globs (e.g. include:["*.ts"], exclude:["*.min.js"]). Use read on a matched file when you need surrounding context.',
  })

  ctx.tools.register('grep', async (args) => {
    const input = parseGrepArgs(args as GrepArgs)

    const result = await rpc<{ matches: GrepMatch[] }>('grep::search', {
      pattern: input.pattern,
      path: input.path ?? caps.workspaceRoot,
      includes: input.globs,
      maxMatches: input.maxCount,
    })

    const matches = result.matches ?? []
    if (matches.length === 0) return { content: 'No matches found' }

    const kept = matches.slice(0, GREP_MAX_MATCHES).map(match => ({
      ...match,
      line: previewLine(match.line, GREP_MAX_LINE_BYTES),
    }))
    const header = matches.length > GREP_MAX_MATCHES
      ? `Found ${GREP_MAX_MATCHES} of ${matches.length} matches`
      : `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`
    const body = formatGrepMatches(kept)
    const footer = matches.length > GREP_MAX_MATCHES
      ? `(Result capped at ${GREP_MAX_MATCHES} matches; narrow pattern, path, or include to see more.)`
      : undefined

    return { content: footer === undefined ? `${header}\n\n${body}` : `${header}\n\n${body}\n\n${footer}` }
  }, {
    description: 'Search file contents with a ripgrep regular expression (Rust backend). Returns matching lines with line numbers, grouped by file.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for (ripgrep syntax).' },
        path: { type: 'string', description: 'File or directory to search. Defaults to the workspace root.' },
        include: {
          description: 'Glob filter(s) for files to search, e.g. "*.ts" or ["*.ts","*.tsx"]. Supports {a,b} and "!pattern" negation.',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        includes: { type: 'array', items: { type: 'string' }, description: 'Same as include, list form.' },
        exclude: {
          description: 'Glob(s) to exclude, e.g. "*.min.js" or ["dist/**","*.snap"]. Auto-negated for the engine.',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
        maxCount: { type: 'number', description: 'Maximum matches to keep (default 250).' },
      },
      required: ['pattern'],
    },
  })
}
