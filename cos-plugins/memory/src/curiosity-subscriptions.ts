// @diver/memory — 固定源订阅执行：检查到期源、发现变化并入队。
//
// 订阅本身只负责「发现变化」，不联网查证：
// - GitHub：GET /releases?per_page=1，带 ETag；新 release 的 body 作为 payload
// - 页面（可选，默认不启用）：抓正文 → 指纹 → 行级 diff → 新增行作为 payload
// 入队后由壳端 ExplorePolicy 在空闲时消费；job 见到 payload 会跳过二次搜索。
// 源配置与仓库识别在 ./curiosity-subscription-sources.ts。

import { extractContent } from '@diver/web-tools/extract'
import { fetchPage, resolveHttpUrl } from '@diver/web-tools/fetch'
import { DEFAULT_POLICY } from '@diver/web-tools/policy'

import { addedLines, clipLines, hashText, normalizeLines } from './curiosity-diff.ts'
import { withCuriosityState } from './curiosity-state.ts'
import {
  collectRepoSignals,
  detectRepos,
  readSubscriptionSources,
  REPO_SCAN_MS,
  type SubscriptionSource,
} from './curiosity-subscription-sources.ts'
import { persistCandidates } from './curiosity-persist.ts'
import type { CuriosityCandidate } from './curiosity-sources.ts'
import { cosHome } from './session.ts'
import type { MemoryStore } from './store-rpc.ts'

export interface SubscriptionState {
  lastCheckedAt?: number
  lastHash?: string
  lastText?: string
  lastReleaseId?: number
  etag?: string
  lastError?: string
  backoffUntil?: number
}

export interface SubscriptionConfig {
  curiosityEnabled?: boolean
  subscriptions?: boolean
  extraRepos?: string
}

const PAGE_BUDGET = 20_000

interface CheckOutcome {
  state: SubscriptionState
  candidate?: CuriosityCandidate
}

/** 检查所有到期订阅；返回新增条目数。 */
export async function refreshSubscriptions(
  store: MemoryStore,
  config: SubscriptionConfig,
  opts: { home?: string; now?: number; repos?: string[] } = {},
): Promise<number> {
  if (config.curiosityEnabled === false || config.subscriptions === false) return 0
  const home = opts.home ?? cosHome()
  const now = opts.now ?? Date.now()
  let added = 0

  await withCuriosityState(home, async (state) => {
    if (opts.repos === undefined && now - (state.repoScanAt ?? 0) >= REPO_SCAN_MS) {
      state.repos = detectRepos(await collectRepoSignals(store, home))
      state.repoScanAt = now
    }
    const sources = readSubscriptionSources(home, config.extraRepos, opts.repos ?? state.repos ?? [])
    const cursors = (state.subscriptions ??= {}) as Record<string, SubscriptionState>

    for (const source of sources) {
      const prev = cursors[source.id] ?? {}
      if (prev.backoffUntil !== undefined && prev.backoffUntil > now) continue
      if (prev.lastCheckedAt !== undefined && now - prev.lastCheckedAt < source.intervalMs) continue
      try {
        const outcome =
          source.kind === 'github'
            ? await checkGithub(source, prev, now)
            : await checkPage(source, prev, now)
        cursors[source.id] = outcome.state
        if (outcome.candidate !== undefined) {
          added += await persistCandidates(store, [outcome.candidate])
          console.log(`[curiosity] 订阅 ${source.id} 发现新条目「${outcome.candidate.term}」`)
        }
      } catch (err) {
        const message = (err as Error)?.message ?? String(err)
        const backoff = /HTTP 403|rate limit/i.test(message) ? 3600_000 : 30 * 60_000
        cursors[source.id] = {
          ...prev,
          lastCheckedAt: now,
          backoffUntil: now + backoff,
          lastError: message.slice(0, 200),
        }
        console.warn(`[curiosity] 订阅 ${source.id} 失败: ${message}`)
      }
    }
  })
  return added
}

async function checkPage(
  source: SubscriptionSource,
  prev: SubscriptionState,
  now: number,
): Promise<CheckOutcome> {
  if (source.url === undefined) throw new Error('page source missing url')
  const page = await fetchPage(source.url, DEFAULT_POLICY)
  const extracted = extractContent(page.body, PAGE_BUDGET)
  const lines = normalizeLines(extracted.markdown)
  const text = lines.join('\n')
  const hash = hashText(text)
  const state: SubscriptionState = {
    lastCheckedAt: now,
    lastHash: hash,
    lastText: text.slice(-20_000),
    lastError: '',
  }
  if (prev.lastHash === undefined) return { state } // 首次只记基线
  if (prev.lastHash === hash) return { state }
  if (text.length < 200) {
    console.warn(`[curiosity] 订阅 ${source.id} 正文过短（可能是 SPA），建议在 sources.json 换 URL`)
    return { state: { ...state, lastHash: prev.lastHash } }
  }
  const added = clipLines(addedLines(normalizeLines(prev.lastText ?? ''), lines), 800)
  if (added.trim() === '') return { state }
  return {
    state,
    candidate: {
      term: source.title.slice(0, 40),
      source: `subscription:${source.id}`,
      reason: 'watch',
      priority: 2.0,
      dedupeKey: `watch:${source.id}:${hash}`,
      note: `${source.title} 有更新`,
      payload: `${source.title} 有更新\n${added}\n${source.url}`.slice(0, 4000),
    },
  }
}

async function checkGithub(
  source: SubscriptionSource,
  prev: SubscriptionState,
  now: number,
): Promise<CheckOutcome> {
  const repo = source.repo
  if (repo === undefined) throw new Error('github source missing repo')
  const res = await fetchGithubReleases(repo, prev.etag)
  if (res.status === 304) return { state: { ...prev, lastCheckedAt: now, lastError: '' } }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
  let releases: Array<{ id?: number; tag_name?: string; name?: string; body?: string; html_url?: string }>
  try {
    releases = JSON.parse(res.body) as typeof releases
  } catch {
    throw new Error('release JSON 解析失败')
  }
  const latest = Array.isArray(releases) ? releases[0] : undefined
  if (latest === undefined || typeof latest.id !== 'number') {
    return { state: { lastCheckedAt: now, etag: res.etag, lastError: '' } }
  }
  const state: SubscriptionState = {
    lastCheckedAt: now,
    lastReleaseId: latest.id,
    etag: res.etag,
    lastError: '',
  }
  if (prev.lastReleaseId === undefined || prev.lastReleaseId === latest.id) return { state }
  const tag = latest.tag_name ?? String(latest.id)
  return {
    state,
    candidate: {
      term: repo,
      source: `subscription:github:${repo}`,
      reason: 'release',
      priority: 2.0,
      dedupeKey: `release:${repo}:${latest.id}`,
      note: `${tag} ${latest.name ?? ''}`.trim().slice(0, 120),
      payload: [repo, tag, latest.name ?? '', latest.body ?? '', latest.html_url ?? '']
        .filter((line) => line !== '')
        .join('\n')
        .slice(0, 4000),
    },
  }
}

async function fetchGithubReleases(
  repo: string,
  etag?: string,
): Promise<{ status: number; etag?: string; body: string }> {
  const target = resolveHttpUrl(`https://api.github.com/repos/${repo}/releases?per_page=1`, DEFAULT_POLICY)
  const headers: Record<string, string> = {
    'user-agent': DEFAULT_POLICY.userAgent,
    accept: 'application/vnd.github+json',
  }
  if (etag !== undefined) headers['if-none-match'] = etag
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_POLICY.timeoutMs)
  try {
    const res = await fetch(target, { headers, signal: controller.signal })
    return { status: res.status, etag: res.headers.get('etag') ?? undefined, body: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}
