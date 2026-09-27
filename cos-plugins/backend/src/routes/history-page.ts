// /api/history 分页切片（纯函数，与视图模型解耦，单测友好）：
// - rounds=N：以 user 消息为轮次边界，取最近 N 轮的尾窗（打开时只加载一两周对话）
// - before=<id>&limit=N：以某条消息为锚点向前取块（滚动到顶懒加载更早消息）
// 锚点按 id 定位，id 缺失时按时间兜底（last index with time < beforeTime）。

/** 尾窗硬上限：轮次扫描遇到超长 turn（大量工具步骤）时兜底。 */
export const ROUNDS_TAIL_CAP = 120
/** 懒加载单块默认条数。 */
export const DEFAULT_CHUNK_LIMIT = 60

export interface HistoryQuery {
  rounds?: number
  before?: string
  beforeTime?: number
  limit: number
}

export interface HistoryPage<T> {
  list: readonly T[]
  hasMore: boolean
}

/** 解析 /history 查询串；非法值一律忽略（保持默认行为）。 */
export function parseHistoryQuery(url: string | undefined): HistoryQuery {
  const params = new URL(url ?? '/', 'http://localhost').searchParams
  const num = (key: string): number | undefined => {
    const raw = params.get(key)
    if (raw === null || raw === '') return undefined
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  const rounds = num('rounds')
  const limit = num('limit')
  const beforeTime = num('beforeTime')
  const before = params.get('before') || undefined
  return {
    ...(rounds !== undefined && rounds > 0 ? { rounds: Math.min(Math.floor(rounds), 20) } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(beforeTime !== undefined && beforeTime > 0 ? { beforeTime: Math.floor(beforeTime) } : {}),
    limit:
      limit !== undefined && limit > 0 ? Math.min(Math.floor(limit), 200) : DEFAULT_CHUNK_LIMIT,
  }
}

interface Sliceable {
  kind?: unknown
  id?: unknown
  time?: unknown
}

/**
 * 最近 N 轮尾窗：轮次边界 = kind 为 'user' 的消息（真人 / peer / 群广播，
 * 不含 system 注入）。从尾部向前数第 N 个 user 消息起全部保留；
 * 超出 ROUNDS_TAIL_CAP 时从更早一侧裁掉（hasMore 据此为 true）。
 */
export function roundTail<T extends Sliceable>(
  messages: readonly T[],
  rounds: number,
): HistoryPage<T> {
  let start = 0
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].kind !== 'user') continue
    seen += 1
    if (seen >= rounds) {
      start = i
      break
    }
  }
  // 轮次不足 N 时从头开始；再叠硬上限兜底
  if (messages.length - start > ROUNDS_TAIL_CAP) start = messages.length - ROUNDS_TAIL_CAP
  return { list: messages.slice(start), hasMore: start > 0 }
}

/** 锚点下标：id 精确命中；未命中且给了 beforeTime 时取 time < beforeTime 的最后一条之后。 */
function anchorIndexBefore(messages: readonly Sliceable[], query: HistoryQuery): number {
  if (query.before !== undefined) {
    const idx = messages.findIndex((m) => String(m.id) === query.before)
    if (idx >= 0) return idx
  }
  if (query.beforeTime !== undefined) {
    let at = 0
    for (let i = 0; i < messages.length; i += 1) {
      const t = Number(messages[i].time)
      if (Number.isFinite(t) && t >= query.beforeTime) return at
      at = i + 1
    }
    return at
  }
  return -1
}

/**
 * 取锚点之前（不含锚点）的至多 limit 条。锚点定位失败返回空页；
 * 锚点已在最顶（下标 0）返回空页 + hasMore=false。
 */
export function chunkBefore<T extends Sliceable>(
  messages: readonly T[],
  query: HistoryQuery,
): HistoryPage<T> {
  const anchor = anchorIndexBefore(messages, query)
  if (anchor <= 0) return { list: [], hasMore: false }
  const start = Math.max(0, anchor - query.limit)
  return { list: messages.slice(start, anchor), hasMore: start > 0 }
}
