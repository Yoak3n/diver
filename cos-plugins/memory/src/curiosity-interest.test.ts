import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildInterestProfile, scoreCandidate } from './curiosity-interest.ts'
import type { PlatformCandidate } from './curiosity-platform-types.ts'

function candidate(overrides: Partial<PlatformCandidate> = {}): PlatformCandidate {
  return {
    id: 'BV1',
    title: '视频',
    description: '',
    uploader: '',
    category: '',
    duration: 300,
    view: 1000,
    danmaku: 10,
    reply: 0,
    pubdate: 0,
    url: 'https://www.bilibili.com/video/BV1',
    tags: [],
    ...overrides,
  }
}

test('兴趣画像：显式词优先、过滤元话题、笔记只取明确标记', () => {
  const profile = buildInterestProfile({
    topics: ['MXene', '会话', '日常', 'Rust'],
    entities: ['量子退火', '用户'],
    notes: '《拓扑绝缘体》和「伊辛模型」，普通句子不该被收进来',
    extra: 'AI, 科技',
  })
  assert.deepEqual(profile.queries.slice(0, 2), ['AI', '科技'])
  for (const expected of ['AI', '科技', 'MXene', 'Rust', '量子退火', '拓扑绝缘体', '伊辛模型']) {
    assert.ok(profile.keywords.includes(expected), `缺少 ${expected}`)
  }
  assert.equal(profile.keywords.includes('会话'), false)
  assert.equal(profile.keywords.includes('用户'), false)
  assert.equal(profile.keywords.includes('普通句子不该被收进来'), false)
})

test('命中打分：标题权重 2，简介/标签/分区权重 1', () => {
  const scored = scoreCandidate(
    candidate({ title: 'AI 与生活', description: '科技', tags: ['Rust'] }),
    ['AI', '科技', 'Rust', '不存在'],
  )
  assert.equal(scored.hits, 4)
  assert.deepEqual(scored.matched, ['AI', '科技', 'Rust'])
})
