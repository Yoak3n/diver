// @diver/memory — 好奇心运行态：$COS_HOME/curiosity/state.json（原子写 + 串行锁）。
//
// 取词游标、订阅位点、汇报记账共用一份状态；并发读-改-写会互相覆盖
// （队列为空时的 force 扫描可能和 30 分钟 tick 撞上），所以统一走
// withCuriosityState 串行化。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { cosHome } from './session.ts'

export interface NoteCursor {
  mtimeMs: number
  size: number
}

/** 运行态（未知字段原样保留，便于后续扩展）。 */
export interface CuriosityState {
  version: 1
  chat: Record<string, number>
  notes: Record<string, NoteCursor>
  lastScanAt: number
  subscriptions?: Record<string, unknown>
  report?: { lastReportAt: number; lastAttemptAt: number; attempts: number }
  /** 自动识别的 GitHub 仓库（6h 重算一次）。 */
  repos?: string[]
  repoScanAt?: number
  /** 平台观察位点：B站等源的 due/backoff/最近看过。 */
  platforms?: Record<
    string,
    {
      lastCheckedAt?: number
      lastAttemptAt?: number
      lastIds?: string[]
      lastError?: string
      backoffUntil?: number
    }
  >
  /** 平台每日配额（本地日期，跨日重置）。 */
  platformDaily?: { day: string; enqueued: Record<string, number> }
}

const STATE_VERSION = 1

export function curiosityRoot(home: string = cosHome()): string {
  return join(home, 'curiosity')
}

export function curiosityStatePath(home: string = cosHome()): string {
  return join(curiosityRoot(home), 'state.json')
}

const EMPTY_STATE: CuriosityState = { version: STATE_VERSION, chat: {}, notes: {}, lastScanAt: 0 }

export function readCuriosityState(home: string = cosHome()): CuriosityState {
  const path = curiosityStatePath(home)
  if (!existsSync(path)) return { ...EMPTY_STATE, chat: {}, notes: {} }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CuriosityState>
    return {
      ...raw,
      version: STATE_VERSION,
      chat: isRecord(raw.chat) ? (raw.chat as Record<string, number>) : {},
      notes: isRecord(raw.notes) ? (raw.notes as Record<string, NoteCursor>) : {},
      lastScanAt: Number(raw.lastScanAt) || 0,
    }
  } catch (err) {
    console.warn(`[curiosity] state.json 损坏，按空状态继续: ${(err as Error)?.message ?? err}`)
    return { ...EMPTY_STATE, chat: {}, notes: {} }
  }
}

export function writeCuriosityState(state: CuriosityState, home: string = cosHome()): void {
  const root = curiosityRoot(home)
  mkdirSync(root, { recursive: true })
  const path = curiosityStatePath(home)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let stateLock: Promise<unknown> = Promise.resolve()

/** 串行化 state.json 的读-改-写（取词/订阅/汇报共用）。 */
export async function withCuriosityState<T>(
  home: string,
  fn: (state: CuriosityState) => Promise<T>,
): Promise<T> {
  const run = stateLock.then(async () => {
    const state = readCuriosityState(home)
    const result = await fn(state)
    writeCuriosityState(state, home)
    return result
  })
  stateLock = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
