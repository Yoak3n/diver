// 图片字节取回/校验单测：magic bytes 嗅探、大小守卫。
import test from 'node:test'
import assert from 'node:assert/strict'

import { guardImageSize, MAX_IMAGE_BYTES, sniffMime } from './img-bytes.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0])

test('sniffMime：magic bytes 四类；认不出为 undefined', () => {
  assert.equal(sniffMime(JPEG), 'image/jpeg')
  assert.equal(sniffMime(PNG), 'image/png')
  assert.equal(sniffMime(GIF), 'image/gif')
  assert.equal(sniffMime(WEBP), 'image/webp')
  assert.equal(sniffMime(new Uint8Array([0, 0, 0, 0])), undefined)
  assert.equal(sniffMime(new Uint8Array([])), undefined)
})

test('guardImageSize：超限抛错，限内原样返回', () => {
  assert.equal(guardImageSize(PNG), PNG)
  const huge = new Uint8Array(MAX_IMAGE_BYTES + 1)
  assert.throws(() => guardImageSize(huge), /图片过大/)
})
