// 出站图片单测：句柄缓存 TTL/定长、image 参数解析、段构造（URL 遮蔽 / base64）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RecentImages,
  describeImages,
  imageSegmentOf,
  imagesInContent,
  parseImageArg,
} from './out-image.ts'
import type { ResolvedConfig } from './config.ts'

const cfg = { privacy: { maskTerms: [], extraPatterns: [] } } as unknown as ResolvedConfig

test('RecentImages：句柄单调递增，超容淘汰最旧', () => {
  const cache = new RecentImages(2, 60_000)
  assert.equal(cache.add({ mime: 'image/png', data: 'a' }, 'desktop', 1000), 'img-1')
  assert.equal(cache.add({ mime: 'image/png', data: 'b' }, 'desktop', 1000), 'img-2')
  assert.equal(cache.add({ mime: 'image/png', data: 'c' }, 'desktop', 1000), 'img-3')
  assert.deepEqual(cache.list(1000).map((it) => it.handle), ['img-3', 'img-2'])
})

test('RecentImages：TTL 过期清扫；resolve 容忍 img-3 / img3 / 3', () => {
  const cache = new RecentImages(4, 1000)
  cache.add({ mime: 'image/png', data: 'a' }, 'desktop', 0)
  cache.add({ mime: 'image/png', data: 'b' }, 'desktop', 500)
  assert.equal(cache.resolve('img-1', 900)?.data, 'a')
  assert.equal(cache.resolve('img1', 900)?.data, 'a')
  assert.equal(cache.resolve('1', 900)?.data, 'a')
  assert.equal(cache.resolve('img-1', 1500), undefined, 'img-1 过期')
  assert.deepEqual(cache.list(1500).map((it) => it.handle), ['img-2'])
  assert.equal(cache.resolve('img-9', 900), undefined)
})

test('parseImageArg：list / URL / 句柄三态', () => {
  assert.equal(parseImageArg(undefined), undefined)
  assert.equal(parseImageArg('  '), undefined)
  assert.deepEqual(parseImageArg('list'), { kind: 'list' })
  assert.deepEqual(parseImageArg('列表'), { kind: 'list' })
  assert.deepEqual(parseImageArg('https://a.example/x.jpg'), { kind: 'url', url: 'https://a.example/x.jpg' })
  assert.deepEqual(parseImageArg('img-3'), { kind: 'handle', token: 'img-3' })
})

test('imageSegmentOf：URL 过遮蔽总闸（带凭据的直链被遮）', () => {
  const got = imageSegmentOf({ kind: 'url', url: 'https://a.example/x.jpg?sign=sk-abcdefghijklmnop123' }, new RecentImages(), cfg)
  assert.ok('segment' in got)
  const file = String((got.segment as { data: { file?: unknown } }).data.file)
  assert.ok(file.startsWith('https://a.example/x.jpg'))
  assert.ok(!file.includes('sk-abcdefghijklmnop123'), '凭据不得离开本机')
  assert.ok((got as { info: { masked?: unknown[] } }).info.masked !== undefined)
})

test('imageSegmentOf：句柄命中转 base64://；未命中给可用清单', () => {
  const cache = new RecentImages()
  cache.add({ mime: 'image/jpeg', data: 'eHg=', name: 'a.jpg' }, 'onebot:g123:456', 1000)
  const hit = imageSegmentOf({ kind: 'handle', token: 'img-1' }, cache, cfg, 1200)
  assert.ok('segment' in hit)
  assert.equal(hit.segment.data.file, 'base64://eHg=')
  assert.deepEqual((hit as { info: Record<string, unknown> }).info.source, 'img-1')

  const miss = imageSegmentOf({ kind: 'handle', token: 'img-7' }, cache, cfg, 1200)
  assert.ok('error' in miss)
  assert.ok(String(miss.error).includes('img-7'))
  assert.ok(Array.isArray(miss.list) && (miss.list as Array<{ handle: string }>)[0].handle === 'img-1')
})

test('describeImages：新→旧，带来源与时间', () => {
  const cache = new RecentImages()
  cache.add({ mime: 'image/png', data: 'a' }, 'desktop', new Date('2026-10-25T00:45:00').getTime())
  const list = describeImages(cache, new Date('2026-10-25T00:46:00').getTime())
  assert.equal(list.length, 1)
  assert.equal(list[0].from, 'desktop')
  assert.equal(list[0].at, '00:45')
})

test('imagesInContent：只抽 image 块（mime+data 齐全）', () => {
  assert.deepEqual(
    imagesInContent([
      { type: 'text', text: '看图' },
      { type: 'image', mime: 'image/png', data: 'aGk=', name: 'x.png' },
      { type: 'image', mime: 'image/png' },
      'not-a-block',
    ]),
    [{ mime: 'image/png', data: 'aGk=', name: 'x.png' }],
  )
  assert.deepEqual(imagesInContent('raw string'), [])
  assert.deepEqual(imagesInContent(undefined), [])
})
