// 出站图片单测：句柄缓存 TTL/定长、image 参数四态解析、三来源（句柄/直链/本地
// 路径）段构造、本地路径的囚笼判定与嗅探拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RecentImages,
  describeImages,
  imagesInContent,
  parseImageArg,
  resolveImageArg,
  type ImageResolveDeps,
} from './out-image.ts'
import { buildFsPolicy } from './fs-jail.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const PNG_B64 = Buffer.from(PNG).toString('base64')

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

test('parseImageArg：list / URL / 句柄 / 本地路径四态', () => {
  assert.equal(parseImageArg(undefined), undefined)
  assert.equal(parseImageArg('  '), undefined)
  assert.deepEqual(parseImageArg('list'), { kind: 'list' })
  assert.deepEqual(parseImageArg('列表'), { kind: 'list' })
  assert.deepEqual(parseImageArg('https://a.example/x.jpg'), { kind: 'url', url: 'https://a.example/x.jpg' })
  assert.deepEqual(parseImageArg('img-3'), { kind: 'handle', token: 'img-3' })
  assert.deepEqual(parseImageArg('3'), { kind: 'handle', token: '3' })
  assert.deepEqual(parseImageArg('/home/u/a.png'), { kind: 'path', path: '/home/u/a.png' })
  assert.deepEqual(parseImageArg('file:///tmp/a.png'), { kind: 'path', path: 'file:///tmp/a.png' })
  assert.deepEqual(parseImageArg('pics/a.png'), { kind: 'path', path: 'pics/a.png' })
})

/** 临时囚笼 deps：根 = 临时目录（realpath），workspace 基准 = 根下 workspace/；直链缺省取回 PNG。 */
async function makeDeps(
  images = new RecentImages(),
  fetchUrl: ImageResolveDeps['fetchUrl'] = async () => PNG,
): Promise<ImageResolveDeps> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'onebot-out-img-')))
  const base = join(root, 'workspace')
  await mkdir(base, { recursive: true })
  return {
    images,
    imageFs: async () => ({ policy: buildFsPolicy(root, [], false), workspaceBase: base }),
    fetchUrl,
  }
}

test('resolveImageArg：句柄命中转 base64://；未命中给清单与写法说明', async () => {
  const cache = new RecentImages()
  cache.add({ mime: 'image/jpeg', data: 'eHg=', name: 'a.jpg' }, 'onebot:g123:456')
  const hit = await resolveImageArg('img-1', await makeDeps(cache))
  assert.ok(hit.kind === 'segment')
  assert.equal(hit.segment.data.file, 'base64://eHg=')
  assert.equal(hit.info.source, 'img-1')

  const miss = await resolveImageArg('img-7', await makeDeps(cache))
  assert.ok(miss.kind === 'reply')
  const payload = JSON.parse(miss.content)
  assert.ok(String(payload.error).includes('img-7'))
  assert.ok(Array.isArray(payload.images) && payload.images[0].handle === 'img-1')
  assert.ok(String(payload.note).includes('直链') && String(payload.note).includes('路径'))
})

test('resolveImageArg：list 回执带可用清单与三种写法', async () => {
  const cache = new RecentImages()
  cache.add({ mime: 'image/png', data: 'aGk=' }, 'desktop')
  const got = await resolveImageArg('list', await makeDeps(cache))
  assert.ok(got.kind === 'reply')
  const payload = JSON.parse(got.content)
  assert.equal(payload.images[0].handle, 'img-1')
  assert.ok(String(payload.note).includes('句柄') && String(payload.note).includes('直链'))
})

test('resolveImageArg：直链本机取回转 base64（URL 不进消息段）；失败/非图片短路', async () => {
  const ok = await resolveImageArg('https://a.example/x.jpg?sign=sk-abcdefghijklmnop123', await makeDeps())
  assert.ok(ok.kind === 'segment')
  assert.equal(ok.segment.data.file, `base64://${PNG_B64}`)
  assert.ok(!JSON.stringify(ok.segment).includes('a.example'), 'URL 与其参数不得进入消息段')
  assert.equal(ok.info.source, 'url')

  const dead = await resolveImageArg(
    'https://a.example/dead.jpg',
    await makeDeps(new RecentImages(), async () => {
      throw new Error('HTTP 404')
    }),
  )
  assert.ok(dead.kind === 'reply')
  assert.ok(dead.content.includes('直链取回失败') && dead.content.includes('HTTP 404'))

  const weird = await resolveImageArg(
    'https://a.example/x.bin',
    await makeDeps(new RecentImages(), async () => new Uint8Array([1, 2, 3, 4])),
  )
  assert.ok(weird.kind === 'reply')
  assert.ok(weird.content.includes('不是可识别的图片'))
})

test('resolveImageArg：囚笼内本地图片 → base64 段（相对路径按 workspace 根、file:// 前缀）', async () => {
  const deps = await makeDeps()
  const { workspaceBase } = await deps.imageFs()
  await mkdir(join(workspaceBase, 'pics'), { recursive: true })
  const file = join(workspaceBase, 'pics', 'a.png')
  await writeFile(file, PNG)

  const rel = await resolveImageArg('pics/a.png', deps)
  assert.ok(rel.kind === 'segment')
  assert.equal(rel.segment.data.file, `base64://${PNG_B64}`)
  assert.equal(rel.info.source, 'file')
  assert.equal(rel.info.name, 'a.png')

  const abs = await resolveImageArg(`file://${file}`, deps)
  assert.ok(abs.kind === 'segment')
  assert.equal(abs.segment.data.file, `base64://${PNG_B64}`)
})

test('resolveImageArg：囚笼外路径被拒；非图片内容被拒', async () => {
  const deps = await makeDeps()
  const outside = join(tmpdir(), 'onebot-outside-jail.png')
  await writeFile(outside, PNG)
  const vetoed = await resolveImageArg(outside, deps)
  assert.ok(vetoed.kind === 'reply')
  assert.ok(vetoed.content.includes('越界'))

  const { workspaceBase } = await deps.imageFs()
  await writeFile(join(workspaceBase, 'note.txt'), 'plain text, not an image')
  const notImg = await resolveImageArg('note.txt', deps)
  assert.ok(notImg.kind === 'reply')
  assert.ok(notImg.content.includes('不是可识别的图片文件'))
})

test('resolveImageArg：未传 image → none', async () => {
  assert.deepEqual(await resolveImageArg(undefined, await makeDeps()), { kind: 'none' })
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
