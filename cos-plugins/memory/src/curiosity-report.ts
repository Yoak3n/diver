// @diver/memory — 探索小结：每两天最多一次，攒够 2 条才说。
//
// 投递走壳端 presence 裁决（L1：仅 receptive 相位；L2：ProactiveSpeak 节流），
// 通过后由壳异步 POST sidecar /api/inject。被拒/失败只记账，2 小时后再试；
// 24 小时内最多 3 次，避免在忙碌/静默状态下反复敲门。

import { nativeRpc } from '@diver/native-bridge/rpc'

import { cosHome } from './session.ts'
import { withCuriosityState } from './curiosity-state.ts'
import type { CuriosityRow, MemoryStore } from './store-rpc.ts'

export interface ReportConfig {
  curiosityEnabled?: boolean
  reportEnabled?: boolean
  reportEveryDays?: number
  reportMinItems?: number
}

export interface ReportGate {
  now: number
  lastReportAt: number
  lastAttemptAt: number
  attempts: number
  itemCount: number
  everyDays: number
  minItems: number
}

const REPORT_START_HOUR = 9
const REPORT_END_HOUR = 23
const ATTEMPT_GAP_MS = 2 * 3600_000
const MAX_ATTEMPTS = 3
const DAY_MS = 86_400_000

/** 是否该说：时段、间隔、条数、重试预算四道闸。 */
export function shouldReport(input: ReportGate): boolean {
  const hour = new Date(input.now).getHours()
  if (hour < REPORT_START_HOUR || hour >= REPORT_END_HOUR) return false
  if (input.itemCount < input.minItems) return false
  if (input.lastReportAt > 0 && input.now - input.lastReportAt < input.everyDays * DAY_MS) return false
  if (input.lastAttemptAt > 0 && input.now - input.lastAttemptAt < ATTEMPT_GAP_MS) return false
  if (input.attempts >= MAX_ATTEMPTS && input.now - input.lastAttemptAt < DAY_MS) return false
  return true
}

/** 注入文案：给 agent 的“由头”，不是给用户的报告。最多 3 条。 */
export function buildReportPrompt(items: ReadonlyArray<Pick<CuriosityRow, 'term' | 'note'>>): string {
  const lines = items
    .filter((item) => item.note.trim() !== '')
    .slice(0, 3)
    .map((item, index) => `${index + 1}. ${item.term}：${item.note.trim().slice(0, 120)}`)
  if (lines.length === 0) return ''
  return [
    '【探索小结】这两天摸到几件事：',
    ...lines,
    '挑一件你觉得我会感兴趣的，自然地跟我说说；别逐条复述，也别提“系统/报告/探索任务”。',
  ].join('\n')
}

/** 检查并投递；返回是否成功注入。 */
export async function maybeReport(
  store: MemoryStore,
  config: ReportConfig,
  opts: { home?: string; now?: number; inject?: (text: string) => Promise<boolean> } = {},
): Promise<boolean> {
  if (config.curiosityEnabled === false || config.reportEnabled === false) return false
  const home = opts.home ?? cosHome()
  const now = opts.now ?? Date.now()
  const everyDaysRaw = Number(config.reportEveryDays)
  const everyDays = Number.isFinite(everyDaysRaw) ? Math.max(0, everyDaysRaw) : 2
  const minItemsRaw = Number(config.reportMinItems)
  const minItems = Number.isFinite(minItemsRaw) ? Math.max(1, minItemsRaw) : 2

  return withCuriosityState(home, async (state) => {
    const report = state.report ?? { lastReportAt: 0, lastAttemptAt: 0, attempts: 0 }
    const since = report.lastReportAt > 0 ? report.lastReportAt : now - everyDays * DAY_MS
    let items: CuriosityRow[] = []
    try {
      items = (await store.curiosityDoneSince(since, 10)).filter((row) => row.note.trim() !== '')
    } catch (err) {
      console.warn(`[curiosity] 读取已完成条目失败: ${(err as Error)?.message ?? err}`)
      return false
    }
    if (
      !shouldReport({
        now,
        lastReportAt: report.lastReportAt,
        lastAttemptAt: report.lastAttemptAt,
        attempts: report.attempts,
        itemCount: items.length,
        everyDays,
        minItems,
      })
    ) {
      return false
    }
    const text = buildReportPrompt(items)
    if (text === '') return false

    const ok = await (opts.inject ?? defaultInject)(text)
    state.report = ok
      ? { lastReportAt: now, lastAttemptAt: now, attempts: 0 }
      : { ...report, lastAttemptAt: now, attempts: report.attempts + 1 }
    console.log(`[curiosity] 小结${ok ? '已注入' : '未发送（裁决拒绝/失败）'}（条目 ${items.length}）`)
    return ok
  })
}

async function defaultInject(text: string): Promise<boolean> {
  try {
    const res = await nativeRpc<{ ok?: boolean; reason?: string }>('presence::inject', {
      source: 'curiosity-digest',
      text,
    })
    if (res?.ok !== true) {
      console.log(`[curiosity] 小结未通过裁决: ${res?.reason ?? 'unknown'}`)
    }
    return res?.ok === true
  } catch (err) {
    console.warn(`[curiosity] 小结注入失败: ${(err as Error)?.message ?? err}`)
    return false
  }
}
