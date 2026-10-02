// @diver/delegate —— 通道二/三读取：dsh 会话日志与投影检查点（纯路径/IO 助手）。
//
// 通道一（`--json` 事件流 tee）在壳层 Rust；这里是旁路直读，进程死活都能取：
// - 会话日志 `$DSH_HOME/sessions/<工作区slug>/<sessionId>/session.vN.jsonl(.zstd)`
//   ——增量落盘、崩溃可读；zstd 多帧按 zstd-frames 切开逐帧解（Node 只解单帧）。
// - 投影检查点 `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`
//   ——turn/end 必写 + 节流，零 IO 读，适合摘要（title/stats/todos/…）。
// 所有函数注入根路径（可单测）；默认根取环境（DSH_HOME 缺省 ~/.dsh）。

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { splitZstdFrames } from './zstd-frames.ts'

/** dsh 数据家园（会话日志/检查点所在）。 */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 在 `$DSH_HOME/sessions/<slug>/<sessionId>/` 找会话目录（slug 由工作区派生，不猜）。 */
export function findSessionDir(sessionsRoot: string, sessionId: string): string | null {
  let slugs: string[] = []
  try {
    slugs = readdirSync(sessionsRoot)
  } catch {
    return null
  }
  for (const slug of slugs) {
    const dir = join(sessionsRoot, slug, sessionId)
    if (existsSync(dir)) return dir
  }
  return null
}

/** 读会话日志全部行（取目录内最高 `session.vN.jsonl[.zstd]`）。 */
export function readSessionLogLines(dir: string): string[] {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f))
  } catch {
    return []
  }
  if (files.length === 0) return []
  files.sort((a, b) => logVersion(b) - logVersion(a))
  const file = join(dir, files[0])
  const raw = readFileSync(file)
  const text = file.endsWith('.zstd')
    ? splitZstdFrames(raw)
        .map((frame) => zstdDecompressSync(frame).toString('utf8'))
        .join('')
    : raw.toString('utf8')
  return text.split('\n').filter((l) => l.trim() !== '')
}

function logVersion(name: string): number {
  const m = name.match(/^session(?:\.v(\d+))?\.jsonl/)
  return m && m[1] ? Number(m[1]) : 0
}

export interface SessionEntry {
  type: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result' | 'turn' | 'title'
  text?: string
  tool?: string
  error?: boolean
}

const DEFAULT_MAX_ITEMS = 20
const TEXT_CAP = 2_000

/** 从日志行提取有界条目（尾部 `maxItems` 条，逐条截断；坏行容忍跳过）。 */
export function extractEntries(lines: string[], maxItems = DEFAULT_MAX_ITEMS): SessionEntry[] {
  const entries: SessionEntry[] = []
  for (const line of lines) {
    let row: Record<string, unknown>
    try {
      row = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const entry = toEntry(row)
    if (entry) entries.push(entry)
  }
  return entries.length > maxItems ? entries.slice(-maxItems) : entries
}

function toEntry(row: Record<string, unknown>): SessionEntry | null {
  const data = (row.data ?? {}) as Record<string, any>
  switch (row.type) {
    case 'user/message':
      return { type: 'user', text: cut(contentText(data.message?.content)) }
    case 'assistant/message': {
      const blocks: any[] = Array.isArray(data.message?.content) ? data.message.content : []
      const thinking = blocks
        .filter((b) => b?.type === 'reasoning')
        .map((b) => String(b.text ?? ''))
        .join('\n')
      const text = blocks
        .filter((b) => b?.type === 'text')
        .map((b) => String(b.text ?? ''))
        .join('\n')
      // 有正文取正文；纯推理只记一行缩略（工头摘要不需要大段思考）。
      if (text.trim() !== '') return { type: 'assistant', text: cut(text) }
      if (thinking.trim() !== '') return { type: 'thinking', text: cut(thinking, 400) }
      return null
    }
    case 'tool/call':
      return { type: 'tool_call', tool: String(data.name ?? '?'), text: cut(String(data.arguments ?? ''), 400) }
    case 'tool/result': {
      const message = data.message ?? {}
      return {
        type: 'tool_result',
        error: message.isError === true,
        text: cut(contentText(message.content)),
      }
    }
    case 'turn/end':
      return { type: 'turn', text: String(data.reason?.kind ?? data.reason ?? 'end') }
    case 'session/title':
      return { type: 'title', text: cut(String(data.title ?? ''), 200) }
    default:
      return null
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b?.text === 'string' ? b.text : ''))
      .filter((t: string) => t !== '')
      .join('\n')
  }
  return ''
}

function cut(text: string, cap = TEXT_CAP): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…`
}

/** 读投影检查点（缺文件/坏 JSON 返回 null；整体截断防巨型记录）。 */
export function readCheckpoint(storagesRoot: string, sessionId: string): string | null {
  const file = join(storagesRoot, 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    return cut(readFileSync(file, 'utf8'), 8_000)
  } catch {
    return null
  }
}
