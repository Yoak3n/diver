import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolvePlatformSource, splitList } from './curiosity-platform-config.ts'

test('平台默认：B站、4h、每次 2、每天 2、全站分区', () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-platform-config-'))
  try {
    const source = resolvePlatformSource({}, home)
    assert.ok(source !== null)
    assert.equal(source.id, 'bilibili')
    assert.equal(source.intervalMs, 4 * 3600_000)
    assert.equal(source.perRun, 2)
    assert.equal(source.dailyCap, 2)
    assert.deepEqual(source.rids, [0])
    assert.ok(source.blockKeywords.includes('广告'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('总开关/单平台开关可关闭', () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-platform-off-'))
  try {
    assert.equal(resolvePlatformSource({ platformFeeds: false }, home), null)
    assert.equal(resolvePlatformSource({ platformBilibili: false }, home), null)
    mkdirSync(join(home, 'curiosity'), { recursive: true })
    writeFileSync(join(home, 'curiosity', 'platforms.json'), JSON.stringify({ bilibili: { enabled: false } }))
    assert.equal(resolvePlatformSource({}, home), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('platforms.json 覆盖分区/搜索词/配额，splitList 拆分文本', () => {
  const home = mkdtempSync(join(tmpdir(), 'diver-platform-file-'))
  try {
    mkdirSync(join(home, 'curiosity'), { recursive: true })
    writeFileSync(
      join(home, 'curiosity', 'platforms.json'),
      JSON.stringify({
        bilibili: {
          rids: [36, 188, 99999],
          queries: ['AI', '量子计算'],
          perRun: 1,
          dailyCap: 3,
          intervalMs: 7_200_000,
          blockKeywords: ['广告', '带货'],
        },
      }),
    )
    const source = resolvePlatformSource({ platformPerSession: 3 }, home)
    assert.ok(source !== null)
    assert.deepEqual(source.rids, [36, 188])
    assert.deepEqual(source.queries, ['AI', '量子计算'])
    assert.equal(source.perRun, 1)
    assert.equal(source.dailyCap, 3)
    assert.equal(source.intervalMs, 7_200_000)
    assert.deepEqual(source.blockKeywords, ['广告', '带货'])
    assert.deepEqual(splitList('AI, 科技 生活'), ['AI', '科技', '生活'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
