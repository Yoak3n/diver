// @diver/memory — 订阅源配置与仓库识别（纯函数 + 只读 IO）。
//
// 内置 MiMo/DeepSeek 更新页；GitHub 仓库来自三处：
// 1. $COS_HOME/curiosity/sources.json 手写覆盖/追加
// 2. 插件配置 extraRepos（逗号/换行）
// 3. topics / 实体 / owner 笔记里自动识别（显式 github.com URL 或重复出现的 owner/repo）

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { curiosityRoot } from './curiosity-state.ts'
import { groupBufferTexts, ownerNoteTexts } from './curiosity-sources.ts'
import type { MemoryStore } from './store-rpc.ts'

export interface SubscriptionSource {
  id: string
  kind: 'page' | 'github'
  title: string
  /** page 源必填。 */
  url?: string
  /** github 源必填，owner/repo。 */
  repo?: string
  /** 两次检查的最小间隔（ms）。 */
  intervalMs: number
  enabled?: boolean
}

const THREE_HOURS = 3 * 3600_000
const SIX_HOURS = 6 * 3600_000
const GITHUB_MAX_SOURCES = 8

/** 自动识别仓库的重算间隔（refreshSubscriptions 用）。 */
export const REPO_SCAN_MS = 6 * 3600_000

export const DEFAULT_SOURCES: SubscriptionSource[] = [
  {
    id: 'deepseek-news',
    kind: 'page',
    title: 'DeepSeek 更新',
    url: 'https://api-docs.deepseek.com/news',
    intervalMs: SIX_HOURS,
  },
  {
    id: 'mimo-docs',
    kind: 'page',
    title: 'MiMo 更新',
    url: 'https://mimo.mi.com/docs',
    intervalMs: SIX_HOURS,
  },
]

/** 读 sources.json（可覆盖内置源）+ extraRepos + 自动识别仓库。 */
export function readSubscriptionSources(
  home: string,
  extraRepos = '',
  autoRepos: readonly string[] = [],
): SubscriptionSource[] {
  const byId = new Map<string, SubscriptionSource>(DEFAULT_SOURCES.map((source) => [source.id, source]))
  const custom = readCustomSources(home)
  for (const source of custom) {
    if (!isValidSource(source)) continue
    byId.set(source.id, source)
  }
  for (const repo of parseRepos(extraRepos)) {
    byId.set(`github:${repo}`, githubSource(repo))
  }
  for (const repo of autoRepos) {
    const id = `github:${repo}`
    if (!byId.has(id)) byId.set(id, githubSource(repo))
  }

  const active = [...byId.values()].filter((source) => source.enabled !== false)
  // GitHub 源上限：默认/手填在前，自动识别的排在后面，超限先丢自动的。
  let github = 0
  return active.filter((source) => {
    if (source.kind !== 'github') return true
    github += 1
    return github <= GITHUB_MAX_SOURCES
  })
}

function githubSource(repo: string): SubscriptionSource {
  return { id: `github:${repo}`, kind: 'github', title: repo, repo, intervalMs: THREE_HOURS }
}

function readCustomSources(home: string): SubscriptionSource[] {
  const path = join(curiosityRoot(home), 'sources.json')
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (Array.isArray(raw)) return raw as SubscriptionSource[]
    const sources = (raw as { sources?: unknown }).sources
    return Array.isArray(sources) ? (sources as SubscriptionSource[]) : []
  } catch (err) {
    console.warn(`[curiosity] sources.json 解析失败，只用内置源: ${(err as Error)?.message ?? err}`)
    return []
  }
}

function isValidSource(source: SubscriptionSource): boolean {
  if (typeof source?.id !== 'string' || source.id.trim() === '') return false
  if (source.kind !== 'page' && source.kind !== 'github') return false
  if (source.kind === 'page' && (typeof source.url !== 'string' || source.url.trim() === '')) return false
  if (source.kind === 'github' && !isRepo(source.repo)) return false
  if (typeof source.title !== 'string' || source.title.trim() === '') return false
  if (!Number.isFinite(source.intervalMs) || source.intervalMs < 60_000) return false
  return true
}

function isRepo(repo: unknown): repo is string {
  return typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
}

/** 解析配置里的 owner/repo 列表（逗号/换行/空格）。 */
export function parseRepos(text: string): string[] {
  const seen = new Set<string>()
  for (const part of text.split(/[\s,，;；]+/)) {
    const repo = part.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '')
    if (!isRepo(repo)) continue
    if (BLOCKED_OWNERS.has(repo.split('/')[0]!.toLowerCase())) continue
    seen.add(repo)
  }
  return [...seen]
}

const BLOCKED_OWNERS = new Set([
  'http', 'https', 'www', 'api', 'docs', 'raw', 'gist', 'github',
  'and', 'or', 'the', 'a', 'an', 'of', 'to', 'in', 'is', 'if', 'at', 'by', 'on',
  'src', 'lib', 'dist', 'test', 'tests', 'packages', 'apps', 'examples',
])

/** 从一段文本里识别仓库：显式 GitHub URL 记 1 次，裸 owner/repo 需出现 ≥2 次。 */
export function detectRepos(text: string): string[] {
  const counts = new Map<string, number>()
  const bump = (repo: string): void => {
    if (!isRepo(repo)) return
    if (BLOCKED_OWNERS.has(repo.split('/')[0]!.toLowerCase())) return
    if (looksLikeFile(repo)) return
    counts.set(repo, (counts.get(repo) ?? 0) + 1)
  }
  for (const match of text.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi)) {
    bump(`${match[1]!}/${match[2]!.replace(/\.git$/i, '')}`)
  }
  for (const match of text.matchAll(/(?<![\w/.-])([A-Za-z0-9][A-Za-z0-9_.-]{1,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{1,38})(?![\w/.-])/g)) {
    bump(`${match[1]!}/${match[2]!}`)
  }
  const lower = text.toLowerCase()
  return [...counts.entries()]
    .filter(([repo, count]) => count >= 2 || lower.includes(`github.com/${repo.toLowerCase()}`))
    .sort((a, b) => b[1] - a[1])
    .map(([repo]) => repo)
    .slice(0, GITHUB_MAX_SOURCES)
}

function looksLikeFile(repo: string): boolean {
  const ext = repo.split('/')[1]?.split('.').pop()?.toLowerCase() ?? ''
  return FILE_EXTS.has(ext)
}

const FILE_EXTS = new Set(['md', 'txt', 'ts', 'tsx', 'js', 'jsx', 'json', 'yml', 'yaml', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'css', 'html', 'py', 'rs', 'toml', 'lock'])

/** 仓库信号：topics + 实体 + owner 笔记（不扫私聊/群笔记）。 */
export async function collectRepoSignals(store: MemoryStore, home: string): Promise<string> {
  const parts: string[] = []
  try {
    for (const row of await store.listTopics()) {
      // 仓库订阅只从主人/全局记忆长出来，不把群聊/私聊 topic 带进订阅。
      if (row.scope !== 'owner' && row.scope !== 'global') continue
      parts.push(row.canonicalName, row.stateSummary)
    }
  } catch (err) {
    console.warn(`[curiosity] 读取 topics 失败: ${(err as Error)?.message ?? err}`)
  }
  try {
    for (const row of await store.listEntities(200)) parts.push(row.name)
  } catch (err) {
    console.warn(`[curiosity] 读取实体失败: ${(err as Error)?.message ?? err}`)
  }
  for (const note of ownerNoteTexts(home)) parts.push(note.text)
  // 群里贴过的 GitHub 链接也算「常提的仓库」；只读最近窗口，不落原句。
  parts.push(groupBufferTexts(home))
  return parts.join('\n').slice(0, 200_000)
}
