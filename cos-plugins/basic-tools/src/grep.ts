// @diver/basic-tools — grep 工具：文件内容搜索（Rust 后端）。
//
// 引擎在 Rust 壳（src-tauri/services/rpc.rs 的 grep::search 方法，ripgrep 引擎），
// Node 侧经现有本地 HTTP RPC 通道调用（与 @diver/memory 同一条
// 127.0.0.1:{DIVER_MEMORY_PORT}/rpc 通道）。
//
// 接口与 DSH 上游 @deepseek-ai/dsh-tool-fs-search/grep 对齐：
// - pattern: ripgrep 正则；path: 目标文件或目录（默认 workspace 根）；
// - include: 单个正向 glob 过滤（非列表、非否定）；
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
  include?: string
}

interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

/** 校验 include 必须是单个正向 glob（非空白、非 ! 开头、非逗号列表）。 */
function validateInclude(include: string): void {
  if (include.trim().length === 0) throw new Error('include must be a non-empty glob when given')
  if (include.startsWith('!')) throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported')
  let braceDepth = 0
  for (const char of include) {
    if (char === '{') braceDepth++
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1)
    else if (char === ',' && braceDepth === 0) {
      throw new Error('include must be one glob, not a comma-separated list (use {a,b} alternation instead)')
    }
  }
}

/** 校验并归一化参数（与上游 parseGrepArgs 对齐）。 */
export function parseGrepArgs(args: GrepArgs): GrepArgs {
  if (args.pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (args.path !== undefined && args.path.trim().length === 0) throw new Error('path must be a non-empty string when given')
  if (args.include !== undefined) validateInclude(args.include)
  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    ...args.include !== undefined ? { include: args.include } : {},
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
    text: 'Use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.',
  })

  ctx.tools.register('grep', async (args) => {
    const input = parseGrepArgs(args as GrepArgs)

    const result = await rpc<{ matches: GrepMatch[] }>('grep::search', {
      pattern: input.pattern,
      path: input.path ?? caps.workspaceRoot,
      include: input.include,
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
        include: { type: 'string', description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
      },
      required: ['pattern'],
    },
  })
}
