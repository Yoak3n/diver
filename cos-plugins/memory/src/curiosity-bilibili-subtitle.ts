// @diver/memory — 登录态字幕：player/wbi/v2 → 字幕 JSON → 文本节选。
//
// 字幕需要 SESSDATA；CDN 字幕 URL 自带 auth_key，不再附带登录 cookie。
// 只读：不调用任何写接口。

import type { WebPolicy } from '@diver/web-tools/policy'

import type { FetchJsonLike } from './curiosity-bilibili-auth.ts'
import { parseSubtitleBody, parseSubtitleTrack } from './curiosity-bilibili-parse.ts'
import { signWbiQuery } from './curiosity-bilibili-wbi.ts'

export interface BilibiliSubtitleDeps {
  getJson: <T>(
    url: string,
    headers?: Record<string, string>,
    useAuth?: boolean,
  ) => Promise<T>
  fetchJson: FetchJsonLike
  policy: WebPolicy
  headers: () => Record<string, string>
  throttle: () => Promise<void>
  wbiMixin: () => Promise<string>
  now: () => number
}

const PLAYER_URL = 'https://api.bilibili.com/x/player/wbi/v2'

export async function fetchBilibiliSubtitle(
  deps: BilibiliSubtitleDeps,
  bvid: string,
  cid: number,
): Promise<{ text: string; lang: string } | null> {
  const mixin = await deps.wbiMixin()
  const signed = signWbiQuery({ bvid, cid }, mixin, Math.floor(deps.now() / 1000))
  const json = await deps.getJson<unknown>(`${PLAYER_URL}?${signed}`, {}, true)
  const track = parseSubtitleTrack(json)
  if (track === null) return null

  await deps.throttle()
  const res = await deps.fetchJson<unknown>(track.url, deps.policy, {
    headers: deps.headers(),
    maxBytes: 1024 * 1024,
  })
  if (res.status >= 400 || res.json === null) return null
  const text = parseSubtitleBody(res.json, 3000)
  return text === '' ? null : { text, lang: track.lang }
}
