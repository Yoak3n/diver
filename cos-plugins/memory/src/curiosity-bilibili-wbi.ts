// @diver/memory — B 站 WBI 签名（纯函数）。
//
// 搜索/评论的 WBI 变体需要 wts + w_rid；key 来自 /x/web-interface/nav 的
// wbi_img.img_url/sub_url（未登录也能取到，code -101 不影响 data）。
// 算法：mixin_key 固定重排表 → 参数排序编码 → MD5(sorted + mixin_key)。

import { createHash } from 'node:crypto'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const

/** 从 wbi_img 的 URL 里取文件名（去掉扩展名）。 */
export function extractWbiKey(url: string): string {
  const last = url.split('/').pop() ?? ''
  return last.split('.')[0] ?? ''
}

/** 64 位原始 key → 32 位 mixin_key。 */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = `${imgKey}${subKey}`
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '').join('').slice(0, 32)
}

/**
 * 生成带 wts/w_rid 的查询串。
 * @param nowSec Unix 秒（外部传入便于测试）
 */
export function signWbiQuery(
  params: Record<string, string | number | undefined>,
  mixin: string,
  nowSec: number,
): string {
  const entries: Array<[string, string]> = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || String(value) === '') continue
    entries.push([key, String(value)])
  }
  entries.push(['wts', String(nowSec)])
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const sorted = entries
    .map(([key, value]) => {
      const clean = value.replace(/[!'()*]/g, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(clean)}`
    })
    .join('&')
  const wRid = createHash('md5').update(`${sorted}${mixin}`).digest('hex')
  return `${sorted}&w_rid=${wRid}`
}

/** 解析 /x/web-interface/nav 的 wbi_img（未登录 code -101 也带 data）。 */
export function parseWbiNav(json: unknown): { imgKey: string; subKey: string } | null {
  const data = (json as { data?: { wbi_img?: { img_url?: unknown; sub_url?: unknown } } } | null)?.data
  const imgUrl = data?.wbi_img?.img_url
  const subUrl = data?.wbi_img?.sub_url
  if (typeof imgUrl !== 'string' || typeof subUrl !== 'string') return null
  const imgKey = extractWbiKey(imgUrl)
  const subKey = extractWbiKey(subUrl)
  if (imgKey === '' || subKey === '') return null
  return { imgKey, subKey }
}

/** 解析 /x/frontend/finger/spi 的匿名设备 id。 */
export function parseBuvid(json: unknown): { buvid3: string; buvid4: string } | null {
  const data = (json as { data?: { b_3?: unknown; b_4?: unknown } } | null)?.data
  const buvid3 = typeof data?.b_3 === 'string' ? data.b_3 : ''
  if (buvid3 === '') return null
  return { buvid3, buvid4: typeof data?.b_4 === 'string' ? data.b_4 : '' }
}
