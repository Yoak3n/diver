// @diver/memory — 平台观察配置：插件 configDecl + 可选 platforms.json。
//
// 默认只在 B 站匿名观察；高级项（分区、搜索词、屏蔽词）放
// $COS_HOME/curiosity/platforms.json，避免把通用设置表单塞爆。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { curiosityRoot } from './curiosity-state.ts'

export interface PlatformRuntimeConfig {
  platformFeeds?: boolean
  platformBilibili?: boolean
  platformSearch?: boolean
  platformComments?: boolean
  platformDanmaku?: boolean
  /** 使用已保存的 B 站登录态（只读 SESSDATA）；关掉则完全匿名。 */
  platformLogin?: boolean
  /** 登录态下读取字幕（需要 SESSDATA）。 */
  platformSubtitles?: boolean
  platformPerSession?: number
  platformDailyCap?: number
  platformIntervalMin?: number
  platformIdleMinutes?: number
  platformSerendipity?: number
  platformInterests?: string
  platformPresenceGate?: boolean
}

export interface ResolvedPlatformSource {
  id: string
  title: string
  intervalMs: number
  perRun: number
  dailyCap: number
  rids: number[]
  queries: string[]
  blockKeywords: string[]
}

const DEFAULT_INTERVAL_MS = 4 * 3600_000
const MIN_INTERVAL_MS = 60 * 60_000
const MAX_INTERVAL_MS = 24 * 3600_000
const DEFAULT_BLOCK_KEYWORDS = ['广告', '带货', '抽奖', '扫码', '加群', '私信', '优惠', '下单']

/** 解析 B 站源；关掉返回 null。 */
export function resolvePlatformSource(
  config: PlatformRuntimeConfig,
  home: string,
): ResolvedPlatformSource | null {
  if (config.platformFeeds === false || config.platformBilibili === false) return null
  const file = readPlatformFile(home).bilibili
  if (file?.enabled === false) return null

  const intervalMin = num(config.platformIntervalMin, 240)
  const intervalMs = clamp(
    num(file?.intervalMs, intervalMin * 60_000),
    MIN_INTERVAL_MS,
    MAX_INTERVAL_MS,
  )
  const blockKeywords = normalizeList(file?.blockKeywords, 20, 20)
  return {
    id: 'bilibili',
    title: 'B站',
    intervalMs,
    perRun: clampInt(num(file?.perRun, num(config.platformPerSession, 2)), 1, 3),
    dailyCap: clampInt(num(file?.dailyCap, num(config.platformDailyCap, 2)), 1, 6),
    rids: normalizeRids(file?.rids),
    queries: normalizeList(file?.queries, 6, 30),
    blockKeywords: blockKeywords.length > 0 ? blockKeywords : DEFAULT_BLOCK_KEYWORDS,
  }
}

export function platformSerendipity(config: PlatformRuntimeConfig): number {
  return clampInt(num(config.platformSerendipity, 30), 0, 80)
}

export function platformIdleMinutes(config: PlatformRuntimeConfig): number {
  return clampInt(num(config.platformIdleMinutes, 20), 5, 180)
}

export function platformPresenceGate(config: PlatformRuntimeConfig): boolean {
  return config.platformPresenceGate !== false
}

/** 逗号/空白分隔的短列表。 */
export function splitList(text: string | undefined, max = 20, maxChars = 30): string[] {
  if (typeof text !== 'string') return []
  return normalizeList(
    text.split(/[\s,，;；、]+/),
    max,
    maxChars,
  )
}

interface BilibiliFileConfig {
  enabled?: boolean
  intervalMs?: number
  perRun?: number
  dailyCap?: number
  rids?: unknown
  queries?: unknown
  blockKeywords?: unknown
}

function readPlatformFile(home: string): { bilibili?: BilibiliFileConfig } {
  const path = join(curiosityRoot(home), 'platforms.json')
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    const row = (raw as { bilibili?: unknown } | null)?.bilibili
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return {}
    return { bilibili: row as BilibiliFileConfig }
  } catch (err) {
    console.warn(`[platform] platforms.json 解析失败，用默认配置: ${(err as Error)?.message ?? err}`)
    return {}
  }
}

function normalizeRids(value: unknown): number[] {
  if (!Array.isArray(value)) return [0]
  const out: number[] = []
  for (const item of value) {
    const n = Number(item)
    if (!Number.isInteger(n) || n < 0 || n > 10_000) continue
    if (!out.includes(n)) out.push(n)
    if (out.length >= 3) break
  }
  return out.length > 0 ? out : [0]
}

function normalizeList(value: unknown, max: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '' || text.length > maxChars) continue
    if (!out.includes(text)) out.push(text)
    if (out.length >= max) break
  }
  return out
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function clampInt(value: number, min: number, max: number): number {
  return Math.trunc(clamp(value, min, max))
}
