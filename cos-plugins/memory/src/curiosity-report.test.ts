import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildReportPrompt, maybeReport, shouldReport } from './curiosity-report.ts'
import { readCuriosityState, writeCuriosityState } from './curiosity-state.ts'
import type { CuriosityRow, MemoryStore } from './store-rpc.ts'

const DAY = 86_400_000

function row(term: string, note: string, doneAt: number): CuriosityRow {
  return {
    id: `c-${term}`,
    term,
    dedupeKey: term,
    source: 'chat:group:1',
    reason: 'chat_mention',
    priority: 1,
    status: 'done',
    occurrences: 2,
    attempts: 1,
    createdAt: doneAt - 1000,
    updatedAt: doneAt,
    lastSeenAt: doneAt - 1000,
    lastAttemptAt: doneAt - 500,
    doneAt,
    topicId: 't1',
    note,
    payload: '',
    score: 0,
  }
}

function fakeStore(items: CuriosityRow[]): MemoryStore {
  return {
    curiosityDoneSince: async () => items,
  } as unknown as MemoryStore
}

/** 本地时间某天 10:00（避开 09–23 之外）。 */
function dayAt(offset: number): number {
  const d = new Date(2026, 0, 10 + offset, 10, 0, 0)
  return d.getTime()
}

test('shouldReport 卡时段/间隔/条数/重试', () => {
  const base = {
    now: dayAt(3),
    lastReportAt: dayAt(0),
    lastAttemptAt: 0,
    attempts: 0,
    itemCount: 2,
    everyDays: 2,
    minItems: 2,
  }
  assert.equal(shouldReport(base), true)
  assert.equal(shouldReport({ ...base, itemCount: 1 }), false)
  assert.equal(shouldReport({ ...base, lastReportAt: dayAt(2) }), false)
  assert.equal(shouldReport({ ...base, now: new Date(2026, 0, 13, 2, 0).getTime() }), false)
  assert.equal(shouldReport({ ...base, lastAttemptAt: dayAt(3) - 30 * 60_000, attempts: 1 }), false)
  assert.equal(shouldReport({ ...base, lastAttemptAt: dayAt(3) - 30 * 60_000, attempts: 3 }), false)
})

test('buildReportPrompt 最多 3 条且是给 agent 的由头', () => {
  const text = buildReportPrompt([
    row('MXene', '二维材料', 0),
    row('DeepSeek', '发了新模型', 0),
    row('cos', '发了 v0.2.14', 0),
    row('多余', '不会出现', 0),
  ])
  assert.ok(text.includes('MXene：二维材料'))
  assert.ok(text.includes('3. cos：发了 v0.2.14'))
  assert.equal(text.includes('多余'), false)
  assert.ok(text.includes('自然地跟我说说'))
})

test('maybeReport 成功后推进 lastReportAt，失败按退避重试', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-report-'))
  try {
    const now = dayAt(3)
    writeCuriosityState({
      version: 1,
      chat: {},
      notes: {},
      lastScanAt: now,
      report: { lastReportAt: dayAt(0), lastAttemptAt: 0, attempts: 0 },
    }, home)
    const items = [row('MXene', '二维材料', now - 1000), row('DeepSeek', '发了新模型', now - 2000)]
    const sent: string[] = []
    const ok = await maybeReport(fakeStore(items), { reportEveryDays: 2, reportMinItems: 2 }, {
      home,
      now,
      inject: async (text) => {
        sent.push(text)
        return true
      },
    })
    assert.equal(ok, true)
    assert.equal(sent.length, 1)
    assert.equal(readCuriosityState(home).report?.lastReportAt, now)

    // 立刻再调：间隔不够。
    assert.equal(await maybeReport(fakeStore(items), {}, { home, now: now + 1000, inject: async () => true }), false)

    // 裁决拒绝：记一次尝试，2 小时内不再试。
    const rejectAt = now + 3 * DAY
    writeCuriosityState({
      version: 1,
      chat: {},
      notes: {},
      lastScanAt: now,
      report: { lastReportAt: dayAt(0), lastAttemptAt: 0, attempts: 0 },
    }, home)
    assert.equal(await maybeReport(fakeStore(items), {}, { home, now: rejectAt, inject: async () => false }), false)
    const state = readCuriosityState(home)
    assert.equal(state.report?.attempts, 1)
    assert.equal(state.report?.lastAttemptAt, rejectAt)
    assert.equal(
      await maybeReport(fakeStore(items), {}, { home, now: rejectAt + 60_000, inject: async () => true }),
      false,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
