import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickTerms, setCuriosityRefresh } from './explore.ts'
import type { CuriosityRow, MemoryStore, TopicRow } from './store-rpc.ts'

function topic(overrides: Partial<TopicRow>): TopicRow {
  return {
    id: 't1',
    canonicalName: 'MXene',
    aliases: [],
    stateSummary: '二维材料',
    weight: 1,
    tier: 'episodic',
    activationCount: 1,
    createdAt: 0,
    lastDiscussedAt: Date.now(),
    nTimes: 3,
    uncertain: false,
    scope: 'owner',
    ...overrides,
  }
}

function queueItem(overrides: Partial<CuriosityRow>): CuriosityRow {
  return {
    id: 'c1',
    term: '量子退火',
    dedupeKey: '量子退火',
    source: 'chat:group:1',
    reason: 'chat_mention',
    priority: 1.2,
    status: 'open',
    occurrences: 2,
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    lastSeenAt: 0,
    lastAttemptAt: null,
    doneAt: null,
    topicId: null,
    note: '',
    payload: '',
    score: 2,
    ...overrides,
  }
}

test('pickTerms 队列优先，topics 只补 owner/global', async () => {
  const store = {
    curiosityPick: async () => [queueItem({})],
    listTopics: async () => [
      topic({ id: 'owner', canonicalName: 'Rust', scope: 'owner' }),
      topic({ id: 'group', canonicalName: '群聊词', scope: 'group:1' }),
      topic({ id: 'private', canonicalName: '陌生人词', scope: 'private:9' }),
    ],
  } as unknown as MemoryStore

  const terms = await pickTerms(store, 5)
  assert.equal(terms[0]?.term, '量子退火')
  assert.equal(terms[0]?.curiosityId, 'c1')
  assert.ok(terms.some((t) => t.term === 'Rust'))
  assert.equal(terms.some((t) => t.term === '群聊词'), false)
  assert.equal(terms.some((t) => t.term === '陌生人词'), false)
})

test('队列为空时触发一次取词扫描并重取', async () => {
  let refreshed = 0
  let items: CuriosityRow[] = []
  const store = {
    curiosityPick: async () => items,
    listTopics: async () => [],
  } as unknown as MemoryStore

  setCuriosityRefresh(async () => {
    refreshed += 1
    items = [queueItem({ term: '扫描出来的词' })]
  })
  try {
    const terms = await pickTerms(store, 5)
    assert.equal(refreshed, 1)
    assert.equal(terms[0]?.term, '扫描出来的词')
  } finally {
    setCuriosityRefresh(null)
  }
})
