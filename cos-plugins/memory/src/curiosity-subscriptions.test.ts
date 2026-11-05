import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { addedLines, clipLines, hashText, normalizeLines } from './curiosity-diff.ts'
import {
  detectRepos,
  parseRepos,
  readSubscriptionSources,
} from './curiosity-subscription-sources.ts'

test('addedLines 取多重集差集并保留顺序', () => {
  const prev = ['a', 'b', 'c']
  const next = ['b', 'c', 'd', 'd']
  assert.deepEqual(addedLines(prev, next), ['d', 'd'])
  assert.deepEqual(addedLines([], ['x']), ['x'])
  assert.deepEqual(addedLines(['x'], ['x']), [])
})

test('normalizeLines / clipLines / hashText', () => {
  assert.deepEqual(normalizeLines('  a  b \n\n c '), ['a b', 'c'])
  assert.equal(clipLines(['abcdef'], 3), 'abc…')
  assert.equal(hashText('same'), hashText('same'))
  assert.notEqual(hashText('same'), hashText('diff'))
})

test('detectRepos 认显式 URL 与重复出现的裸 owner/repo', () => {
  const text = [
    'https://github.com/Yoak3n/cos 更新了',
    '看 deepseek-ai/deepseek-harness 的 release',
    'deepseek-ai/deepseek-harness 又发版了',
    '单次出现的 foo/bar 不算',
    'package.json 里的 a/b 不算',
  ].join('\n')
  const repos = detectRepos(text)
  assert.ok(repos.includes('Yoak3n/cos'))
  assert.ok(repos.includes('deepseek-ai/deepseek-harness'))
  assert.equal(repos.includes('foo/bar'), false)
})

test('parseRepos 去重并过滤非仓库串', () => {
  assert.deepEqual(parseRepos('alpha/beta, alpha/beta; c/d\nfoo, 不是仓库, https://github.com/x/y.git'), ['alpha/beta', 'c/d', 'x/y'])
})

test('默认不轮询任何页面源', () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-subscriptions-default-'))
  try {
    const sources = readSubscriptionSources(home, '', [])
    assert.equal(sources.filter((s) => s.kind === 'page').length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('readSubscriptionSources 合并手填/自动并限制 GitHub 上限', () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-subscriptions-'))
  try {
    mkdirSync(join(home, 'curiosity'), { recursive: true })
    writeFileSync(
      join(home, 'curiosity', 'sources.json'),
      JSON.stringify([
        { id: 'deepseek-news', kind: 'page', title: 'DeepSeek 更新', url: 'https://example.com/news', intervalMs: 3600000 },
        { id: 'custom-page', kind: 'page', title: '自定义源', url: 'https://example.com/page', intervalMs: 7200000 },
      ]),
    )
    const auto = Array.from({ length: 10 }, (_, i) => `owner/repo-${i}`)
    const sources = readSubscriptionSources(home, 'manual/repo', auto)
    assert.equal(sources.find((s) => s.id === 'deepseek-news')?.url, 'https://example.com/news')
    assert.ok(sources.some((s) => s.id === 'custom-page'))
    assert.ok(sources.some((s) => s.id === 'github:manual/repo'))
    const github = sources.filter((s) => s.kind === 'github')
    assert.equal(github.length, 8)
    assert.ok(github.some((s) => s.repo === 'manual/repo'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
