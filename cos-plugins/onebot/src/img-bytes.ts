// @diver/onebot — 图片字节取回与校验（入站收图 / 出站发图共用）。
//
// 只认 QQ 常见四类格式（magic bytes 嗅探，不信扩展名）；大小守卫只防病态
// 文件撑爆内存。直链下载带超时；本地读取走调用方已过囚笼判定的路径。

import { readFile } from 'node:fs/promises'

/** 直链取回器（测试可注入；缺省 fetch + 超时）。 */
export type UrlFetcher = (url: string) => Promise<Uint8Array>

/** 病态大文件的内存守卫；常规 QQ 图远小于此。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** 直链下载超时。 */
const FETCH_TIMEOUT_MS = 15_000

/** magic bytes 嗅探（QQ 常见四类）；认不出的格式返回 undefined。 */
export function sniffMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  // webp：RIFF 头 + 8..11 偏移的 WEBP 标记
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return undefined
}

export function guardImageSize(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`图片过大（${bytes.byteLength} 字节）`)
  return bytes
}

/** 直链 → 字节（超时 + 大小守卫）。 */
export async function fetchImageBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return guardImageSize(new Uint8Array(await res.arrayBuffer()))
}

/** 本地路径 → 字节（大小守卫；路径须已过囚笼判定）。 */
export async function readImageFile(path: string): Promise<Uint8Array> {
  return guardImageSize(new Uint8Array(await readFile(path)))
}
