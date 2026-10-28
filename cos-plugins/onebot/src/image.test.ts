// 入站图片取回单测：引用回图解析、逐图容错与去重。
import test from 'node:test'
import assert from 'node:assert/strict'

import { collectWakeImages } from './image.ts'
import type { OnebotClient } from './ws.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])

/** 假 client：按 action 返回预设或抛错。 */
function fakeClient(handlers: Record<string, () => unknown>): OnebotClient {
  return {
    call: async <T>(action: string): Promise<T> => {
      const h = handlers[action]
      if (h === undefined) throw new Error(`unexpected action ${action}`)
      return h() as T
    },
  } as unknown as OnebotClient
}

test('collectWakeImages：url 直链取回 + base64 编码', async () => {
  const client = fakeClient({})
  const { images, notes } = await collectWakeImages(
    [{ type: 'image', data: { url: 'https://m.example/a.png', file: 'a.png' } }],
    { client, fetchUrl: async () => PNG },
  )
  assert.deepEqual(notes, [])
  assert.equal(images.length, 1)
  assert.equal(images[0].mime, 'image/png')
  assert.equal(images[0].data, Buffer.from(PNG).toString('base64'))
  assert.equal(images[0].name, 'a.png')
})

test('collectWakeImages：引用回图——get_msg 取被引用消息里的图', async () => {
  const client = fakeClient({
    get_msg: () => ({ message: [{ type: 'image', data: { url: 'https://m.example/quoted.jpg' } }] }),
  })
  const { images } = await collectWakeImages(
    [
      { type: 'reply', data: { id: '1417386915' } },
      { type: 'at', data: { qq: '3143775623' } },
      { type: 'text', data: { text: '这张图看到不？' } },
    ],
    { client, fetchUrl: async (url) => {
      assert.equal(url, 'https://m.example/quoted.jpg')
      return JPEG
    } },
  )
  assert.equal(images.length, 1)
  assert.equal(images[0].mime, 'image/jpeg')
})

test('collectWakeImages：get_msg 失败不拖垮自身图；同 url 去重', async () => {
  const client = fakeClient({
    get_msg: () => {
      throw new Error('消息不存在')
    },
  })
  const segs = [
    { type: 'reply', data: { id: '1' } },
    { type: 'image', data: { url: 'https://m.example/a.png' } },
    { type: 'image', data: { url: 'https://m.example/a.png' } },
  ]
  const { images, notes } = await collectWakeImages(segs, { client, fetchUrl: async () => PNG })
  assert.equal(images.length, 1)
  assert.deepEqual(notes, [])
})

test('collectWakeImages：单图失败记 note，格式认不出记 note', async () => {
  let first = true
  const { images, notes } = await collectWakeImages(
    [
      { type: 'image', data: { url: 'https://m.example/dead.png' } },
      { type: 'image', data: { url: 'https://m.example/weird.bin' } },
    ],
    {
      client: fakeClient({}),
      fetchUrl: async () => {
        if (first) {
          first = false
          throw new Error('HTTP 404')
        }
        return new Uint8Array([1, 2, 3, 4])
      },
    },
  )
  assert.deepEqual(images, [])
  assert.equal(notes.length, 2)
  assert.ok(notes[0].includes('HTTP 404'))
  assert.ok(notes[1].includes('格式认不出'))
})

test('collectWakeImages：引用负 id 的表情包（NapCat 表情包 = image 段 + 负 message_id）', async () => {
  // 实测形态：QQ 表情包在 NapCat 里已是 image 段（sub_type=1，summary [动画表情]），
  // 但它所在消息的 message_id 为负；引用解析不能因此放弃取图。
  const asked: Array<Record<string, unknown>> = []
  const client = {
    call: async <T>(action: string, params: Record<string, unknown>): Promise<T> => {
      assert.equal(action, 'get_msg')
      asked.push(params)
      return {
        message: [{
          type: 'image',
          data: {
            url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=x',
            file: 'E07C9DD2B9EC98135EDD651B930CAF88.jpg',
            sub_type: 1,
            summary: '[动画表情]',
          },
        }],
      } as T
    },
  } as unknown as OnebotClient
  const { images, notes } = await collectWakeImages(
    [
      { type: 'reply', data: { id: '-531603186' } },
      { type: 'at', data: { qq: '3143775623' } },
      { type: 'text', data: { text: ' 这是你吗' } },
    ],
    { client, fetchUrl: async () => JPEG },
  )
  assert.deepEqual(asked, [{ message_id: -531603186 }])
  assert.deepEqual(notes, [])
  assert.equal(images.length, 1)
  assert.equal(images[0].mime, 'image/jpeg')
})

test('collectWakeImages：缓存名走 get_image 换直链', async () => {
  const client = fakeClient({
    get_image: () => ({ url: 'https://m.example/resolved.jpg' }),
  })
  const { images } = await collectWakeImages(
    [{ type: 'image', data: { file: 'ABC123.image' } }],
    { client, fetchUrl: async (url) => {
      assert.equal(url, 'https://m.example/resolved.jpg')
      return JPEG
    } },
  )
  assert.equal(images.length, 1)
  assert.equal(images[0].mime, 'image/jpeg')
})

test('collectWakeImages：超张数封顶并记 note', async () => {
  const segs = Array.from({ length: 6 }, (_, i) => ({
    type: 'image',
    data: { url: `https://m.example/${i}.png` },
  }))
  const { images, notes } = await collectWakeImages(segs, { client: fakeClient({}), fetchUrl: async () => PNG })
  assert.equal(images.length, 4)
  assert.ok(notes.some((n) => n.includes('图片过多')))
})
