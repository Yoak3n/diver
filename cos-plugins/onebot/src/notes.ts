// @diver/onebot — 笔记作用域与路径规则（纯逻辑，无 IO）。
//
// 笔记是 OneBot 回合唯一的写入口：只追加、不覆盖/删除，按回合来源分作用域
// （owner / group-<群号> / private-<QQ号>），与 memory 的 writeScope 同构。
// 文件落在 $COS_HOME/notes/<scope>/，模型只能给作用域内的相对路径；父目录由
// 工具自动创建，深度/条目/字节数都在这里定上限。
//
// 作用域目录名必须文件系统安全：memory 的 `group:<id>` 里有冒号，Windows
// 文件名非法，这里统一改成 `group-<id>` / `private-<id>`。

import { createHash } from 'node:crypto'
import { extname } from 'node:path'

import { isDeniedFileName } from './fs-jail.ts'
import { isOwnerSource, type OnebotSource } from './sandbox.ts'

/** 目录层级上限（文件本身不计入）。 */
export const NOTE_MAX_DEPTH = 3
/** 单个作用域内文件 + 目录条目上限。 */
export const NOTE_MAX_ENTRIES = 64
/** 单文件字节上限。 */
export const NOTE_MAX_FILE_BYTES = 64 * 1024
/** 单个作用域总字节上限。 */
export const NOTE_MAX_SCOPE_BYTES = 512 * 1024
/** 单回合追加次数上限。 */
export const NOTE_MAX_TURN_APPENDS = 2
/** 单回合追加字节上限（含来源头与分隔符）。 */
export const NOTE_MAX_TURN_BYTES = 8 * 1024
/** 单段文件名/目录名最大字符数。 */
export const NOTE_MAX_NAME_CHARS = 48
/** 相对路径最大字符数。 */
export const NOTE_MAX_PATH_CHARS = 160

/** 允许的文本扩展名；无扩展名也放行。 */
export const NOTE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.txt', '.jsonl', ''])

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** 笔记作用域目录名；非法 ID 用哈希兜底，避免 `..`/分隔符逃逸。 */
export function noteScopeDir(source: OnebotSource | undefined, ownerIds: readonly string[]): string {
  if (source === undefined) return 'owner'
  if (source.kind === 'group') return `group-${safeId(source.groupId)}`
  return isOwnerSource(source, ownerIds) ? 'owner' : `private-${safeId(source.userId)}`
}

function safeId(id: string): string {
  if (/^\d+$/.test(id)) return id
  return createHash('sha256').update(id).digest('hex').slice(0, 16)
}

export interface NotePath {
  /** 目录段（已逐段校验）。 */
  segments: readonly string[]
  /** 文件名（已校验）。 */
  file: string
  /** 作用域内相对路径，posix 分隔符。 */
  rel: string
}

export class NotePathError extends Error {}

/** 校验作用域内相对路径；任何可疑输入直接拒绝，不做「猜意图」修正。 */
export function parseNotePath(raw: unknown): NotePath {
  if (typeof raw !== 'string') throw new NotePathError('path 必须是字符串')
  const trimmed = raw.trim()
  if (trimmed === '') throw new NotePathError('path 不能为空')
  if (trimmed.length > NOTE_MAX_PATH_CHARS) {
    throw new NotePathError(`path 过长（上限 ${NOTE_MAX_PATH_CHARS} 字符）`)
  }
  // 不 trim 原值：段首/段尾空格由 validateSegment 拒绝，避免写出带空格的文件名。
  const normalized = raw.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new NotePathError('path 必须是笔记作用域内的相对路径，不能是绝对路径')
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part === '')) {
    throw new NotePathError('path 不能包含空路径段（开头/结尾/连续斜杠）')
  }
  const file = parts[parts.length - 1]!
  const segments = parts.slice(0, -1)
  if (segments.length > NOTE_MAX_DEPTH) {
    throw new NotePathError(`目录层级过深（上限 ${NOTE_MAX_DEPTH} 层）`)
  }
  for (const segment of segments) validateSegment(segment, '目录名')
  validateSegment(file, '文件名')
  if (isDeniedFileName(file)) {
    throw new NotePathError('该文件名是敏感落盘保留名（凭据/记录/配置），换一个。')
  }
  const ext = extname(file).toLowerCase()
  if (!NOTE_TEXT_EXTENSIONS.has(ext)) {
    throw new NotePathError('只允许文本笔记：.md / .txt / .jsonl 或无扩展名')
  }
  return { segments, file, rel: [...segments, file].join('/') }
}

function validateSegment(segment: string, label: string): void {
  if (segment === '.' || segment === '..') throw new NotePathError(`${label}不能是 "." 或 ".."`)
  if (segment.length > NOTE_MAX_NAME_CHARS) {
    throw new NotePathError(`${label}过长（上限 ${NOTE_MAX_NAME_CHARS} 字符）`)
  }
  if (segment.startsWith('.')) throw new NotePathError(`${label}不能以 "." 开头`)
  if (/[\u0000-\u001f\u007f]/.test(segment)) throw new NotePathError(`${label}包含控制字符`)
  if (/[:*?"<>|]/.test(segment)) throw new NotePathError(`${label}包含非法字符（: * ? " < > |）`)
  if (/^\s|\s$/.test(segment)) throw new NotePathError(`${label}不能以空白开头或结尾`)
  if (/[.]$/.test(segment)) throw new NotePathError(`${label}不能以点结尾`)
  const base = segment.split('.')[0]!.toUpperCase()
  if (WINDOWS_RESERVED.has(base)) throw new NotePathError(`${label}"${segment}"是系统保留名`)
}

export interface NoteBlockMeta {
  at: Date
  source: OnebotSource | undefined
}

/**
 * 生成一次追加块：来源头 + 正文，保证以换行结尾。
 * `.jsonl` 跳过来源头，避免破坏逐行 JSON。
 */
export function formatNoteBlock(content: string, meta: NoteBlockMeta, file: string): string {
  if (content.includes('\u0000')) throw new NotePathError('content 不能包含 NUL 字符')
  const body = content.endsWith('\n') ? content : `${content}\n`
  if (extname(file).toLowerCase() === '.jsonl') return body

  const source = meta.source === undefined
    ? 'desktop'
    : meta.source.kind === 'group'
      ? `group:${meta.source.groupId}`
      : `private:${meta.source.userId}`
  // OneBot 事件里的 id 理论上来自外部；来源头是工具生成的，控制字符先清掉，
  // 避免一条换行伪造出第二段「来源」。
  const safeSource = source.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 64)
  const stamp = meta.at.toISOString()
  const header = extname(file).toLowerCase() === '.md'
    ? `<!-- ${stamp} | ${safeSource} -->`
    : `[${stamp} | ${safeSource}]`
  return `${header}\n${body}`
}

export interface NoteTurnBudget {
  appends: number
  bytes: number
}

/** 回合额度判定；放行返回 undefined。 */
export function noteBudgetVeto(budget: NoteTurnBudget, payloadBytes: number): string | undefined {
  if (budget.appends >= NOTE_MAX_TURN_APPENDS) {
    return `本回合笔记追加次数已达上限（${NOTE_MAX_TURN_APPENDS} 次），下个回合再写。`
  }
  if (budget.bytes + payloadBytes > NOTE_MAX_TURN_BYTES) {
    return `本回合笔记额度不足（上限 ${NOTE_MAX_TURN_BYTES} 字节），下个回合再写。`
  }
  return undefined
}
