// @diver/memory — 好奇心取词语料源（IO）。
//
// 只碰三类「自己的生活」：
// - 群聊滚动缓冲：$COS_HOME/onebot/groups/*.jsonl（只存词，不存原句）
// - owner 笔记：$COS_HOME/notes/owner/**（不扫 private-*/group-*，避免把别人的私聊带进主人记忆）
// - 记忆实体表：mention_count >= 2 的实体
//
// 游标状态落 $COS_HOME/curiosity/state.json（见 ./curiosity-state.ts）。
// 扫描单飞 + 30 分钟节流；队列为空时允许 force，但有 2 分钟地板，防 45s tick 打爆。

import type { Dirent } from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { extractChatTerms, extractNoteTerms, type CuriosityReason } from './curiosity-extract.ts'
import {
  readCuriosityState,
  withCuriosityState,
  type CuriosityState,
  type NoteCursor,
} from './curiosity-state.ts'
import { persistCandidates } from './curiosity-persist.ts'
import type { MemoryStore } from './store-rpc.ts'
import { cosHome } from './session.ts'

/** 一次扫描产出的候选（尚未落库）。 */
export interface CuriosityCandidate {
  term: string
  source: string
  reason: CuriosityReason
  priority: number
  note?: string
  payload?: string
  dedupeKey?: string
}

export interface CuriositySourceConfig {
  curiosityEnabled?: boolean
  chatScan?: boolean
  notesScan?: boolean
  /** 每轮最多新增条目数（默认 20）。 */
  scanLimit?: number
}

const SCAN_THROTTLE_MS = 30 * 60_000
const FORCE_FLOOR_MS = 2 * 60_000
const CHAT_BACKFILL_MS = 24 * 3600_000
const CHAT_MAX_AGE_MS = 7 * 24 * 3600_000
const NOTE_EXTS = new Set(['.md', '.txt'])
const NOTE_MAX_BYTES = 64 * 1024

/** 群聊缓冲扫描：按文件游标只取新消息；首次回填最近 24h。 */
export function scanChatBuffers(
  home: string,
  state: CuriosityState,
  now: number,
  limit: number,
): { candidates: CuriosityCandidate[]; chat: Record<string, number> } {
  const dir = join(home, 'onebot', 'groups')
  const nextChat = { ...state.chat }
  const candidates: CuriosityCandidate[] = []
  if (!existsSync(dir)) return { candidates, chat: nextChat }

  const files = readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()
  for (const name of files) {
    const path = join(dir, name)
    const groupId = basename(name, '.jsonl')
    const cursor = Number(state.chat[path] ?? 0) || now - CHAT_BACKFILL_MS
    const lines = readBufferedMessages(path, Math.max(cursor, now - CHAT_MAX_AGE_MS))
    nextChat[path] = Math.max(cursor, ...lines.map((line) => line.time))
    if (lines.length === 0) continue
    const terms = extractChatTerms(lines).slice(0, Math.min(10, limit))
    for (const term of terms) {
      candidates.push({
        term: term.term,
        source: `chat:group:${groupId}`,
        reason: term.reason,
        priority: term.priority,
      })
      if (candidates.length >= limit) break
    }
    if (candidates.length >= limit) break
  }
  return { candidates, chat: nextChat }
}

function readBufferedMessages(path: string, since: number): Array<{ time: number; userId: string; text: string }> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: Array<{ time: number; userId: string; text: string }> = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      const time = Number(row.time) || 0
      const text = String(row.text ?? '')
      if (time <= since || text === '') continue
      out.push({ time, userId: String(row.userId ?? ''), text })
    } catch {
      // 坏行跳过：缓冲是背景素材，不阻塞扫描。
    }
  }
  return out
}

/** owner 笔记扫描：按 mtime+size 只读变化过的文件。 */
export function scanNotes(
  home: string,
  state: CuriosityState,
  limit: number,
): { candidates: CuriosityCandidate[]; notes: Record<string, NoteCursor> } {
  const root = join(home, 'notes', 'owner')
  const nextNotes = { ...state.notes }
  const candidates: CuriosityCandidate[] = []
  if (!existsSync(root)) return { candidates, notes: nextNotes }

  for (const path of walkNoteFiles(root)) {
    let info: ReturnType<typeof statSync>
    try {
      info = statSync(path)
    } catch {
      continue
    }
    if (!info.isFile() || info.size > NOTE_MAX_BYTES) continue
    const prev = state.notes[path]
    if (prev !== undefined && prev.mtimeMs === info.mtimeMs && prev.size === info.size) continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue // 读失败不推进游标，下次再试
    }
    nextNotes[path] = { mtimeMs: info.mtimeMs, size: info.size }
    for (const term of extractNoteTerms(text)) {
      candidates.push({
        term: term.term,
        source: 'note:owner',
        reason: term.reason,
        priority: term.priority,
      })
      if (candidates.length >= limit) break
    }
    if (candidates.length >= limit) break
  }
  return { candidates, notes: nextNotes }
}

/** 群聊缓冲的最近正文（只读；订阅仓库识别用，不落任何原句）。 */
export function groupBufferTexts(home: string): string {
  const dir = join(home, 'onebot', 'groups')
  if (!existsSync(dir)) return ''
  const parts: string[] = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
    for (const line of readBufferedMessages(join(dir, name), 0).slice(-500)) {
      parts.push(line.text)
      if (parts.length >= 5000) break
    }
    if (parts.length >= 5000) break
  }
  return parts.join('\n')
}

/** owner 笔记全文（订阅仓库识别等只读场景用；不碰 private-* / group-*）。 */
export function ownerNoteTexts(home: string): Array<{ path: string; text: string }> {
  const root = join(home, 'notes', 'owner')
  if (!existsSync(root)) return []
  const out: Array<{ path: string; text: string }> = []
  for (const path of walkNoteFiles(root)) {
    try {
      const info = statSync(path)
      if (!info.isFile() || info.size > NOTE_MAX_BYTES) continue
      out.push({ path, text: readFileSync(path, 'utf8') })
    } catch {
      // 单文件读失败跳过
    }
  }
  return out
}

function walkNoteFiles(root: string, depth = 0): string[] {
  if (depth > 3) return []
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walkNoteFiles(path, depth + 1))
    else if (entry.isFile() && NOTE_EXTS.has(entry.name.slice(entry.name.lastIndexOf('.')))) out.push(path)
  }
  return out
}

/** 实体表取词：高频实体（提到 ≥2 次）才值得外部查证。 */
export async function collectEntityCandidates(
  store: MemoryStore,
  limit: number,
): Promise<CuriosityCandidate[]> {
  let rows
  try {
    rows = await store.listEntities(200)
  } catch (err) {
    console.warn(`[curiosity] 读取实体失败: ${(err as Error)?.message ?? err}`)
    return []
  }
  const out: CuriosityCandidate[] = []
  for (const row of rows) {
    const term = (row.name ?? '').trim()
    if (term.length < 2 || term.length > 40) continue
    if (row.mentionCount < 2) continue
    if (/^(用户|我|助手|ai|人工智能助手)$/i.test(term)) continue
    out.push({
      term,
      source: 'entity',
      reason: 'entity',
      priority: 1.5 + Math.min(row.mentionCount, 5) * 0.05,
    })
    if (out.length >= limit) break
  }
  return out
}

let scanning: Promise<number> | null = null

function scanDue(state: CuriosityState, now: number, force: boolean): boolean {
  const since = now - state.lastScanAt
  return force ? since >= FORCE_FLOOR_MS : since >= SCAN_THROTTLE_MS
}

/**
 * 按需补货：队列为空时由 pickTerms 调用。
 * 单飞 + 节流；force 时只跳过 30 分钟节流，仍有 2 分钟地板。
 */
export async function refreshCuriositySources(
  store: MemoryStore,
  config: CuriositySourceConfig,
  opts: { force?: boolean; home?: string; now?: number } = {},
): Promise<number> {
  if (config.curiosityEnabled === false) return 0
  if (scanning !== null) return scanning
  const home = opts.home ?? cosHome()
  const now = opts.now ?? Date.now()
  const force = opts.force === true
  if (!scanDue(readCuriosityState(home), now, force)) return 0

  scanning = withCuriosityState(home, async (state) => {
    if (!scanDue(state, now, force)) return 0
    const limit = Math.max(1, Number(config.scanLimit) || 20)
    let added = 0
    if (config.chatScan !== false) {
      const chat = scanChatBuffers(home, state, now, limit)
      state.chat = chat.chat
      added += await persistCandidates(store, chat.candidates)
    }
    if (config.notesScan !== false) {
      const notes = scanNotes(home, state, limit)
      state.notes = notes.notes
      added += await persistCandidates(store, notes.candidates)
    }
    added += await persistCandidates(store, await collectEntityCandidates(store, limit))
    state.lastScanAt = now
    console.log(
      `[curiosity] 取词完成 写入=${added} 群文件=${Object.keys(state.chat).length}` +
        ` 笔记=${Object.keys(state.notes).length}`,
    )
    return added
  }).finally(() => {
    scanning = null
  })
  return scanning
}
