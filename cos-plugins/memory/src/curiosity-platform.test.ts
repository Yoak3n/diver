import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { refreshPlatformFeeds } from './curiosity-platform.ts'
import type { PlatformAdapter, PlatformCandidate } from './curiosity-platform-types.ts'
import { curiosityStatePath, type CuriosityState } from './curiosity-state.ts'
import type { MemoryStore } from './store-rpc.ts'

const NOW = new Date(2026, 10, 5, 21, 0, 0).getTime()

function candidate(id: string, title: string, category: string): PlatformCandidate {
  return {
    id,
    title,
    description: '',
    uploader: 'UP',
    category,
    duration: 600,
    view: 100_000,
    danmaku: 100,
    reply: 10,
    pubdate: 1_700_000_000,
    url: `https://www.bilibili.com/video/${id}`,
    tags: [],
  }
}

function fakeStore(upserts: unknown[]): MemoryStore {
  return {
    listTopics: async () => [
      { canonicalName: 'AI', scope: 'owner' },
      { canonicalName: '私聊词', scope: 'private:9' },
    ],
    listEntities: async () => [],
    curiosityUpsert: async (input: unknown) => {
      upserts.push(input)
      return `c-${upserts.length}`
    },
  } as unknown as MemoryStore
}

function adapter(seen: string[]): PlatformAdapter {
  return {
    id: 'bilibili',
    discover: async () => ({
      candidates: [
        candidate('BV1', 'AI 与生活', '知识'),
        candidate('BV2', '今天做饭', '生活'),
        candidate('BV3', 'AI 科技前沿', '科技'),
      ],
      risk: false,
    }),
    observe: async (item) => {
      seen.push(item.id)
      return {
        ...item,
        subject: item.title,
        payload: `payload:${item.id}`,
        danmakuTotal: 100,
        commentsCount: 3,
      }
    },
  }
}

test('平台会话：闲置门控 → 选择 → 入队 → 写位点', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-platform-run-'))
  try {
    const upserts: unknown[] = []
    const seen: string[] = []
    const presence = {
      enabled: true,
      phase_name: 'passive',
      regime: 'normal',
      user_input_active: false,
      proactive: { last_chat_at: NOW - 30 * 60_000 },
    }
    const added = await refreshPlatformFeeds(fakeStore(upserts), {}, {
      home,
      now: NOW,
      presence,
      adapter: adapter(seen),
      rand: () => 0.1,
    })
    assert.equal(added, 2)
    assert.equal(seen.length, 2)
    assert.ok(seen.includes('BV2'), 'serendipity 条目应被选中')
    const rows = upserts as Array<Record<string, unknown>>
    assert.deepEqual(rows.map((row) => row.source), ['platform:bilibili', 'platform:bilibili'])
    assert.ok(rows.every((row) => String(row.payload).startsWith('payload:')))
    assert.ok(rows.every((row) => String(row.dedupeKey).startsWith('platform:bilibili:')))

    const state = JSON.parse(readFileSync(curiosityStatePath(home), 'utf8')) as CuriosityState
    assert.equal(state.platformDaily?.enqueued.bilibili, 2)
    assert.equal(state.platforms?.bilibili.lastCheckedAt, NOW)
    assert.deepEqual(new Set(state.platforms?.bilibili.lastIds), new Set(seen))

    // 间隔未到：不再抓取。
    const again = await refreshPlatformFeeds(fakeStore([]), {}, {
      home,
      now: NOW + 60_000,
      presence,
      adapter: adapter([]),
    })
    assert.equal(again, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('不闲置时不抓取、不消耗配额', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-platform-busy-'))
  try {
    const upserts: unknown[] = []
    const added = await refreshPlatformFeeds(fakeStore(upserts), {}, {
      home,
      now: NOW,
      presence: { enabled: true, phase_name: 'thinking', user_input_active: true },
      adapter: adapter([]),
    })
    assert.equal(added, 0)
    assert.equal(upserts.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('每日配额限制每次入队条数', async () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-platform-cap-'))
  try {
    const upserts: unknown[] = []
    const added = await refreshPlatformFeeds(fakeStore(upserts), { platformDailyCap: 1 }, {
      home,
      now: NOW,
      presence: {
        enabled: true,
        phase_name: 'passive',
        regime: 'normal',
        user_input_active: false,
        proactive: { last_chat_at: NOW - 30 * 60_000 },
      },
      adapter: adapter([]),
      rand: () => 0.1,
    })
    assert.equal(added, 1)
    assert.equal(upserts.length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
