// @diver/onebot — 入站图片取回与编码（唤醒消息的附件通道）。
//
// image 段取回优先级：data.url 直链 HTTP GET → data.file 本地路径（剥 file:// 前缀）
// → OneBot 扩展 API get_image（NapCat / LLOneBot 支持，缓存名换直链再走 HTTP）。
// mime 按 magic bytes 嗅探，不信段里的扩展名；大小守卫只防病态文件撑爆内存，
// 不在 token 层面做限制——历史轮的旧图由 session 侧 trimForModel 折叠成占位文本。

import { readFile } from 'node:fs/promises'

import { imageRefsOf, quotedMessageId, toSegments, type ImageRef, type Segment } from './protocol.ts'
import { fetchImageBytes, guardImageSize, sniffMime, type UrlFetcher } from './img-bytes.ts'
import type { OnebotClient } from './ws.ts'

/** 唤醒消息附带的图片（@cos/types createUserMessage 的 images 同形）。 */
export interface WakeImage {
  mime: string
  data: string
  name?: string
}

/** 收集结果：附上的图 + 给兜底文案的说明（失败/超限时模型仍应知道发过图）。 */
export interface WakeImages {
  images: WakeImage[]
  notes: string[]
}

/** 单次唤醒最多附图（防图海轰炸）。 */
const MAX_IMAGES_PER_WAKE = 4
/** API 调用超时。 */
const API_TIMEOUT_MS = 5_000

/** 单个引用 → 字节（按 url / 本地路径 / 缓存名依次尝试）。 */
async function refToBytes(ref: ImageRef, client: OnebotClient, fetchUrl: UrlFetcher): Promise<Uint8Array> {
  if (ref.url !== undefined) return fetchUrl(ref.url)
  const file = ref.file ?? ''
  if (file.startsWith('file://')) return guardImageSize(await readFile(file.slice('file://'.length)))
  if (file.startsWith('/')) return guardImageSize(await readFile(file))
  if (file !== '') {
    // 缓存名（如 ABC123.image）：扩展 API 换直链再下载
    const info = await client.call<{ url?: string }>('get_image', { file }, API_TIMEOUT_MS)
    if (typeof info?.url === 'string' && info.url !== '') return fetchUrl(info.url)
  }
  throw new Error('无可用的取回途径（url/file 均缺失）')
}

export interface CollectDeps {
  client: OnebotClient
  /** 直链取回器；缺省真实 fetch。 */
  fetchUrl?: UrlFetcher
}

/**
 * 收集一次唤醒要附带的图片：触发消息自身的 image 段 + 引用回复指向消息里的
 * image 段（get_msg 取回）。逐图容错：单张失败记 note，不拖垮整轮唤醒。
 */
export async function collectWakeImages(
  segments: readonly Segment[],
  deps: CollectDeps,
): Promise<WakeImages> {
  const fetchUrl = deps.fetchUrl ?? fetchImageBytes
  const refs = imageRefsOf(segments)
  const quoted = quotedMessageId(segments)
  if (quoted !== undefined) {
    try {
      const msg = await deps.client.call<{ message?: unknown }>('get_msg', { message_id: quoted }, API_TIMEOUT_MS)
      if (msg?.message !== undefined) {
        refs.push(...imageRefsOf(toSegments(msg.message as Segment[] | string)))
      }
    } catch {
      // 引用消息取不到：触发消息自身的图仍照常附，不因引用失败整体放弃
    }
  }
  const images: WakeImage[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    if (images.length >= MAX_IMAGES_PER_WAKE) {
      notes.push('图片过多，只附了前几张')
      break
    }
    const key = ref.url ?? ref.file ?? ''
    if (key !== '' && seen.has(key)) continue
    if (key !== '') seen.add(key)
    try {
      const bytes = await refToBytes(ref, deps.client, fetchUrl)
      const mime = sniffMime(bytes)
      if (mime === undefined) {
        notes.push('有一张图格式认不出，未附上')
        continue
      }
      images.push({ mime, data: Buffer.from(bytes).toString('base64'), name: ref.file })
    } catch (error) {
      notes.push(`有一张图未能获取（${error instanceof Error ? error.message : '未知错误'}）`)
    }
  }
  return { images, notes }
}
