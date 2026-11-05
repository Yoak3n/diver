import { test } from 'node:test'
import assert from 'node:assert/strict'

import { selectPlatformCandidates } from './curiosity-platform-select.ts'
import type { PlatformCandidate } from './curiosity-platform-types.ts'

function candidate(overrides: Partial<PlatformCandidate>): PlatformCandidate {
  return {
    id: 'BV1',
    title: '视频',
    description: '',
    uploader: '',
    category: '知识',
    duration: 600,
    view: 10_000,
    danmaku: 100,
    reply: 0,
    pubdate: 0,
    url: 'https://www.bilibili.com/video/BV1',
    tags: [],
    ...overrides,
  }
}

test('选择：过滤垃圾/广告、兴趣优先、留 serendipity 名额', () => {
  const items = [
    candidate({ id: 'ai', title: 'AI 与生活', category: '知识' }),
    candidate({ id: 'cook', title: '今天做饭', category: '生活' }),
    candidate({ id: 'junk', title: '没人看', view: 10, danmaku: 1 }),
    candidate({ id: 'ad', title: 'AI 课程 广告', description: '扫码加群' }),
  ]
  const picked = selectPlatformCandidates(items, {
    keywords: ['AI'],
    perRun: 2,
    serendipity: 50,
    blockKeywords: ['广告', '扫码'],
    rand: () => 0.1,
  })
  assert.equal(picked.length, 2)
  assert.ok(picked.some((p) => p.item.id === 'ai'), '兴趣条目应在')
  assert.ok(picked.some((p) => p.item.id === 'cook'), 'serendipity 条目应在')
  assert.equal(picked.some((p) => p.item.id === 'junk'), false)
  assert.equal(picked.some((p) => p.item.id === 'ad'), false)
})

test('perRun=1 时不强制塞 serendipity', () => {
  const picked = selectPlatformCandidates(
    [
      candidate({ id: 'ai', title: 'AI 与生活' }),
      candidate({ id: 'cook', title: '今天做饭', category: '生活' }),
    ],
    { keywords: ['AI'], perRun: 1, serendipity: 100, rand: () => 0.1 },
  )
  assert.deepEqual(picked.map((p) => p.item.id), ['ai'])
})

test('分区去重：同分区最多一条', () => {
  const picked = selectPlatformCandidates(
    [
      candidate({ id: 'a', title: '热榜一', category: '知识', danmaku: 900 }),
      candidate({ id: 'b', title: '热榜二', category: '知识', danmaku: 800 }),
      candidate({ id: 'c', title: '生活', category: '生活', danmaku: 700 }),
    ],
    { keywords: [], perRun: 2, serendipity: 0, rand: () => 0 },
  )
  assert.equal(picked.length, 2)
  assert.equal(new Set(picked.map((p) => p.item.category)).size, 2)
})
