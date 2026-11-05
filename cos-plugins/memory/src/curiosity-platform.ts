// @diver/memory — 平台观察编排：闲置门控 → due/backoff/配额 → 抓取 → 选择 → 入队。
//
// 两段式 state：锁 A 只做到期/配额/占坑，网络抓取在锁外；锁 B 写结果与位点。
// 单飞保证同一进程同时只有一平台会话，避免重复请求和配额竞争。

import { BilibiliObserver } from './curiosity-bilibili.ts'
import type { BilibiliAuth } from './curiosity-bilibili-auth.ts'
import { ensureBilibiliAuth } from './curiosity-bilibili-auth-health.ts'
import { BilibiliError } from './curiosity-bilibili-error.ts'
import {
  buildBilibiliPayload,
  extractSubject,
  type BiliCandidate,
} from './curiosity-bilibili-parse.ts'
import {
  platformIdleMinutes,
  platformPresenceGate,
  platformSerendipity,
  resolvePlatformSource,
  type PlatformRuntimeConfig,
  type ResolvedPlatformSource,
} from './curiosity-platform-config.ts'
import { selectPlatformCandidates } from './curiosity-platform-select.ts'
import type {
  PlatformAdapter,
  PlatformCandidate,
  PlatformDiscoverInput,
  PlatformObservation,
} from './curiosity-platform-types.ts'
import { collectInterestProfile } from './curiosity-interest.ts'
import { persistCandidates } from './curiosity-persist.ts'
import type { CuriosityCandidate } from './curiosity-sources.ts'
import { cosHome } from './session.ts'
import { withCuriosityState, type CuriosityState } from './curiosity-state.ts'
import { isIdleAlone, readPresenceSnapshot, type PresenceSnapshotLike } from './presence-gate.ts'
import type { MemoryStore } from './store-rpc.ts'

const RETRY_FLOOR_MS = 10 * 60_000
const RISK_BACKOFF_MS = 60 * 60_000
const ERROR_BACKOFF_MS = 30 * 60_000

export interface PlatformRefreshOptions {
  home?: string
  now?: number
  /** 测试注入；不传则读 presence::snapshot。 */
  presence?: PresenceSnapshotLike | null
  /** 测试注入；不传则用 B 站匿名适配器。 */
  adapter?: PlatformAdapter
  rand?: () => number
}

let platformRunning: Promise<number> | null = null

/** 一次平台观察会话；返回入队条数。 */
export async function refreshPlatformFeeds(
  store: MemoryStore,
  config: PlatformRuntimeConfig,
  opts: PlatformRefreshOptions = {},
): Promise<number> {
  if (config.platformFeeds === false) return 0
  if (platformRunning !== null) return platformRunning
  const home = opts.home ?? cosHome()
  const now = opts.now ?? Date.now()
  const source = resolvePlatformSource(config, home)
  if (source === null) return 0

  platformRunning = runPlatformSession(store, config, source, home, now, opts).finally(() => {
    platformRunning = null
  })
  return platformRunning
}

async function runPlatformSession(
  store: MemoryStore,
  config: PlatformRuntimeConfig,
  source: ResolvedPlatformSource,
  home: string,
  now: number,
  opts: PlatformRefreshOptions,
): Promise<number> {
  const snapshot = opts.presence !== undefined ? opts.presence : await readPresenceSnapshot()
  if (!isIdleAlone(snapshot, {
    now,
    idleMinutes: platformIdleMinutes(config),
    gateEnabled: platformPresenceGate(config),
  })) {
    return 0
  }

  // 锁 A：到期、退避、每日配额、占坑。
  const pre = await withCuriosityState(home, async (state) => {
    const prev = state.platforms?.[source.id] ?? {}
    if (prev.backoffUntil !== undefined && prev.backoffUntil > now) return null
    if (prev.lastCheckedAt !== undefined && now - prev.lastCheckedAt < source.intervalMs) return null
    if (prev.lastAttemptAt !== undefined && now - prev.lastAttemptAt < RETRY_FLOOR_MS) return null
    const used = dailyCount(state, now, source.id)
    if (used >= source.dailyCap) return null
    state.platforms = { ...state.platforms, [source.id]: { ...prev, lastAttemptAt: now } }
    return { remaining: source.dailyCap - used, lastIds: prev.lastIds ?? [] }
  })
  if (pre === null) return 0

  const interest = await collectInterestProfile(store, home, config.platformInterests)
  const queries = [...new Set([...source.queries, ...interest.queries])].slice(0, 2)
  // 后台体检：有效才用登录态；失效会标记 + 通知 + 自动回退匿名。
  const auth = config.platformLogin === false ? null : await ensureBilibiliAuth(home, { now })
  const adapter = opts.adapter ?? makeBilibiliAdapter(config, now, auth)

  let risk = false
  let discovered
  try {
    discovered = await adapter.discover({ queries, rids: source.rids })
  } catch (err) {
    const isRisk = err instanceof BilibiliError && err.risk
    await recordFailure(home, source.id, now, (err as Error)?.message ?? String(err), isRisk)
    return 0
  }
  risk = discovered.risk

  const known = new Set(pre.lastIds)
  const candidates = discovered.candidates.filter((item) => !known.has(item.id))
  const selected = selectPlatformCandidates(candidates, {
    keywords: interest.keywords,
    perRun: Math.min(source.perRun, pre.remaining),
    serendipity: platformSerendipity(config),
    blockKeywords: source.blockKeywords,
    ...(opts.rand === undefined ? {} : { rand: opts.rand }),
  })

  const observations: Array<{ selected: (typeof selected)[number]; video: PlatformObservation }> = []
  for (const item of selected) {
    try {
      const video = await adapter.observe(item.item)
      observations.push({ selected: item, video })
    } catch (err) {
      if (err instanceof BilibiliError && err.risk) {
        risk = true
        console.warn(`[platform] 观察 ${item.item.id} 触发风控，停止本次会话`)
        break
      }
      console.warn(`[platform] 观察 ${item.item.id} 失败: ${(err as Error)?.message ?? err}`)
    }
  }

  const candidatesToQueue: CuriosityCandidate[] = observations.map(({ selected: pick, video }) => ({
    term: video.subject.slice(0, 40),
    source: `platform:${source.id}`,
    reason: 'platform_trend',
    priority: 1.6 + (pick.hits > 0 ? 0.2 : 0),
    note: `B站 · ${video.category || '视频'} · 播放 ${formatCount(video.view)}`,
    payload: video.payload,
    dedupeKey: `platform:${source.id}:${video.id}`,
  }))
  const added = await persistCandidates(store, candidatesToQueue)
  const observedIds = observations.map(({ video }) => video.id)

  await withCuriosityState(home, async (state) => {
    const prev = state.platforms?.[source.id] ?? {}
    const daily = dayKey(now) === state.platformDaily?.day
      ? state.platformDaily
      : { day: dayKey(now), enqueued: {} }
    daily.enqueued[source.id] = (daily.enqueued[source.id] ?? 0) + added
    state.platformDaily = daily
    state.platforms = {
      ...state.platforms,
      [source.id]: {
        ...prev,
        lastCheckedAt: now,
        lastAttemptAt: now,
        lastIds: unique([...observedIds, ...(prev.lastIds ?? [])]).slice(0, 100),
        lastError: '',
        backoffUntil: risk ? now + RISK_BACKOFF_MS : undefined,
      },
    }
  })

  console.log(
    `[platform] ${source.title} 会话完成：候选 ${discovered.candidates.length} / 选中 ${selected.length}` +
      ` / 入队 ${added}${risk ? '（风控退避）' : ''}`,
  )
  return added
}

function makeBilibiliAdapter(
  config: PlatformRuntimeConfig,
  now: number,
  auth: BilibiliAuth | null,
): PlatformAdapter {
  const client = new BilibiliObserver({
    search: config.platformSearch !== false,
    comments: config.platformComments !== false,
    danmaku: config.platformDanmaku !== false,
    auth,
    subtitles: config.platformSubtitles !== false,
  })
  return {
    id: 'bilibili',
    discover: (input: PlatformDiscoverInput) => client.discover(input.queries, input.rids),
    observe: async (candidate: PlatformCandidate): Promise<PlatformObservation> => {
      const video = await client.observe(candidate as BiliCandidate)
      return {
        ...video,
        subject: extractSubject(video.title),
        payload: buildBilibiliPayload(video, now),
        danmakuTotal: video.danmakuTotal,
        commentsCount: video.comments.length,
      }
    },
  }
}

async function recordFailure(
  home: string,
  sourceId: string,
  now: number,
  message: string,
  risk: boolean,
): Promise<void> {
  console.warn(`[platform] 会话失败（${risk ? '风控' : '普通'}）: ${message}`)
  await withCuriosityState(home, async (state) => {
    const prev = state.platforms?.[sourceId] ?? {}
    state.platforms = {
      ...state.platforms,
      [sourceId]: {
        ...prev,
        lastAttemptAt: now,
        lastError: message.slice(0, 200),
        backoffUntil: now + (risk ? RISK_BACKOFF_MS : ERROR_BACKOFF_MS),
      },
    }
  })
}

function dailyCount(state: CuriosityState, now: number, sourceId: string): number {
  if (state.platformDaily?.day !== dayKey(now)) return 0
  return state.platformDaily.enqueued[sourceId] ?? 0
}

function dayKey(now: number): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function formatCount(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return String(value)
}
