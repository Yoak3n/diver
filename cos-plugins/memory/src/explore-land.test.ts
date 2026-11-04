import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ExploreResult } from '@diver/web-tools/explore'

import {
  buildSummary,
  extractiveDistill,
  landExploration,
  parseDistilled,
} from './explore-land.ts'
import type { MemoryStore } from './store-rpc.ts'

function result(overrides: Partial<ExploreResult> = {}): ExploreResult {
  return {
    term: 'MXene',
    query: 'MXene',
    hits: [{ title: 'MXene - Wikipedia', url: 'https://a.example/mxene', snippet: 'MXene 是一类二维材料。', source: 'ddg' }],
    pages: [
      {
        url: 'https://a.example/mxene',
        title: 'MXene',
        outline: '',
        excerpt: 'MXene 是一类二维过渡金属碳化物。它们具有高导电性。',
      },
    ],
    totalChars: 200,
    budgetExhausted: false,
    summary: '# Explore: MXene',
    ...overrides,
  }
}

test('parseDistilled 支持纯文本与 JSON', () => {
  assert.deepEqual(parseDistilled('MXene 是二维材料。\n- 高导电\n- 可做储能'), {
    oneLine: 'MXene 是二维材料。',
    points: ['高导电', '可做储能'],
  })
  assert.deepEqual(parseDistilled('{"oneLine":"一句话","points":["a"]}'), {
    oneLine: '一句话',
    points: ['a'],
  })
  assert.equal(parseDistilled('   '), null)
})

test('extractiveDistill 取页面首句', () => {
  const d = extractiveDistill('MXene', result())
  assert.ok(d.oneLine.includes('二维过渡金属碳化物'))
  assert.ok(d.points.length >= 1)
})

test('extractiveDistill 能消费订阅 payload（无 pages/hits）', () => {
  const d = extractiveDistill('Yoak3n/cos', result({
    hits: [],
    pages: [],
    summary: 'Yoak3n/cos v0.2.14\n修复了转录丢失。新增了重启续聊。',
  }))
  assert.ok(d.oneLine.includes('v0.2.14'))
  assert.ok(d.points.some((p) => p.includes('重启续聊')))
})

test('buildSummary 带要点与来源并截断', () => {
  const summary = buildSummary({ oneLine: '结论', points: ['要点一', '要点二'] }, result())
  assert.ok(summary.startsWith('【查到】结论'))
  assert.ok(summary.includes('- 要点一'))
  assert.ok(summary.includes('来源：https://a.example/mxene'))
})

test('landExploration 命中已有 topic 时追加而不是覆盖', async () => {
  const calls: string[] = []
  const store = {
    getTopic: async () => ({ id: 't1' }),
    listTopics: async () => [{ id: 't1', canonicalName: 'MXene', scope: 'owner' }],
    blockingCandidates: async () => [],
    appendTopicSummary: async (id: string, text: string) => {
      calls.push(`append:${id}:${text.slice(0, 4)}`)
    },
    createTopic: async () => {
      calls.push('create')
      return 't2'
    },
    appendEvent: async () => {},
  } as unknown as MemoryStore

  const landed = await landExploration(store, {
    term: 'MXene',
    result: result(),
    fromMemoryId: 't1',
    distilled: { oneLine: '结论', points: [] },
  })
  assert.equal(landed.topicId, 't1')
  assert.equal(landed.oneLine, '结论')
  assert.deepEqual(calls, ['append:t1:【查到】'])
})

test('landExploration 无匹配时新建 episodic topic', async () => {
  const created: unknown[] = []
  const store = {
    getTopic: async () => undefined,
    listTopics: async () => [],
    blockingCandidates: async () => [],
    appendTopicSummary: async () => {},
    createTopic: async (input: unknown) => {
      created.push(input)
      return 't9'
    },
    appendEvent: async () => {},
  } as unknown as MemoryStore

  const landed = await landExploration(store, {
    term: '量子退火',
    result: result({ term: '量子退火' }),
    distilled: { oneLine: '一种优化方法', points: ['用于组合优化'] },
  })
  assert.equal(landed.topicId, 't9')
  assert.equal(created.length, 1)
  const input = created[0] as { canonicalName: string; tier: string; scope: string }
  assert.equal(input.canonicalName, '量子退火')
  assert.equal(input.tier, 'episodic')
  assert.equal(input.scope, 'owner')
})
