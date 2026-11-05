// @diver/memory — B 站只读客户端（匿名 + 可选登录态）。
//
// 硬约束：所有请求都是 GET；不调用任何写接口；不保存/发送 bili_jct。
// 登录态只用于更完整的评论与字幕；排行榜始终匿名，避免个人推荐流。
// 412/429/风控码由 BilibiliError 抛出，交给平台编排层退避。

import { fetchJson, type FetchJsonOptions, type FetchJsonResult } from '@diver/web-tools/fetch-json'
import { fetchPage } from '@diver/web-tools/fetch'
import { DEFAULT_POLICY, type WebPolicy } from '@diver/web-tools/policy'

import { parseDanmakuXml } from './curiosity-bilibili-danmaku.ts'
import { parseComments, parseView, type BiliCandidate, type BiliObserved } from './curiosity-bilibili-parse.ts'
import type { BilibiliAuth } from './curiosity-bilibili-auth.ts'
import { discoverBilibili, type BilibiliDiscoverResult } from './curiosity-bilibili-discover.ts'
import { BilibiliError, envelopeCode } from './curiosity-bilibili-error.ts'
import { fetchBilibiliSubtitle } from './curiosity-bilibili-subtitle.ts'
import { mixinKey, parseBuvid, parseWbiNav } from './curiosity-bilibili-wbi.ts'

export type FetchJsonLike = <T>(
  url: string,
  policy: WebPolicy,
  opts?: FetchJsonOptions,
) => Promise<FetchJsonResult<T>>

export type FetchPageLike = (
  url: string,
  policy: WebPolicy,
) => Promise<{ status: number; body: string }>

export interface BilibiliClientOptions {
  policy?: WebPolicy
  /** 请求前节流（默认 1.5–3s + 抖动；测试注入 no-op）。 */
  throttle?: () => Promise<void>
  now?: () => number
  search?: boolean
  comments?: boolean
  danmaku?: boolean
  /** 可选登录态（只含 SESSDATA；用于评论/字幕，不用于写）。 */
  auth?: BilibiliAuth | null
  /** 登录态下是否尝试抓字幕（需要 SESSDATA）。 */
  subtitles?: boolean
  log?: (message: string) => void
  fetchJsonImpl?: FetchJsonLike
  fetchPageImpl?: FetchPageLike
}

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
const BUVID_URL = 'https://api.bilibili.com/x/frontend/finger/spi'
const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'
const REPLY_URL = 'https://api.bilibili.com/x/v2/reply'
const DANMAKU_URL = 'https://comment.bilibili.com'
const REFERER = 'https://www.bilibili.com/'
const NAV_TTL_MS = 10 * 60_000
const BUVID_TTL_MS = 60 * 60_000

export class BilibiliObserver {
  private readonly policy: WebPolicy
  private readonly throttle: () => Promise<void>
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly fetchJsonImpl: FetchJsonLike
  private readonly fetchPageImpl: FetchPageLike
  private readonly searchEnabled: boolean
  private readonly commentsEnabled: boolean
  private readonly danmakuEnabled: boolean
  private readonly auth: BilibiliAuth | null
  private readonly subtitlesEnabled: boolean
  private wbiCache: { mixin: string; at: number } | null = null
  private buvidCache: { cookie: string; at: number } | null = null
  private lastRequestAt = 0

  constructor(opts: BilibiliClientOptions = {}) {
    this.policy = opts.policy ?? DEFAULT_POLICY
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((message) => console.warn(`[bilibili] ${message}`))
    this.fetchJsonImpl = opts.fetchJsonImpl ?? fetchJson
    this.fetchPageImpl = opts.fetchPageImpl ?? ((url, policy) => fetchPage(url, policy))
    this.searchEnabled = opts.search !== false
    this.commentsEnabled = opts.comments !== false
    this.danmakuEnabled = opts.danmaku !== false
    this.auth = opts.auth ?? null
    this.subtitlesEnabled = opts.subtitles !== false
    this.throttle = opts.throttle ?? (() => this.defaultThrottle())
  }

  /** 发现候选：排行榜（主）+ 匿名搜索（可选）；委托 discover 模块。 */
  discover(queries: readonly string[], rids: readonly number[] = [0]): Promise<BilibiliDiscoverResult> {
    return discoverBilibili(
      {
        getJson: <T>(url: string, headers?: Record<string, string>, useAuth?: boolean) =>
          this.getJson<T>(url, headers, useAuth),
        wbiMixin: () => this.wbiMixin(),
        buvidCookie: () => this.buvidCookie(),
        now: this.now,
        log: this.log,
        searchEnabled: this.searchEnabled,
      },
      queries,
      rids,
    )
  }

  /** 深读一条：详情 + 弹幕 + 评论；子请求失败只降级，不拖垮整条。 */
  async observe(candidate: BiliCandidate): Promise<BiliObserved> {
    let video = candidate
    try {
      const json = await this.getJson<unknown>(`${VIEW_URL}?bvid=${encodeURIComponent(candidate.bvid)}`)
      video = parseView(json) ?? candidate
    } catch (err) {
      this.log(`详情 ${candidate.bvid} 失败，用榜单字段: ${(err as Error)?.message ?? err}`)
    }

    let danmakuSample: string[] = []
    let danmakuTotal = 0
    if (this.danmakuEnabled && video.cid !== undefined && video.cid > 0) {
      try {
        const page = await this.fetchDanmaku(video.cid)
        const parsed = parseDanmakuXml(page.body, 120)
        danmakuSample = parsed.sample
        danmakuTotal = parsed.total
      } catch (err) {
        this.log(`弹幕 ${candidate.bvid} 失败（降级）: ${(err as Error)?.message ?? err}`)
      }
    }

    let comments: string[] = []
    if (this.commentsEnabled && video.aid > 0) {
      try {
        comments = parseComments(await this.getComments(video.aid), 20)
      } catch (err) {
        if (err instanceof BilibiliError && err.risk) throw err
        this.log(`评论 ${candidate.bvid} 失败（降级）: ${(err as Error)?.message ?? err}`)
      }
    }

    let subtitleText: string | undefined
    let subtitleLang: string | undefined
    if (this.subtitlesEnabled && this.auth !== null && video.cid !== undefined && video.cid > 0) {
      try {
        const subtitle = await this.fetchSubtitle(video.bvid, video.cid)
        if (subtitle !== null) {
          subtitleText = subtitle.text
          subtitleLang = subtitle.lang
        }
      } catch (err) {
        if (err instanceof BilibiliError && err.risk) throw err
        this.log(`字幕 ${candidate.bvid} 失败（降级）: ${(err as Error)?.message ?? err}`)
      }
    }

    return {
      ...video,
      danmakuTotal,
      danmakuSample,
      comments,
      ...(subtitleText === undefined ? {} : { subtitleText }),
      ...(subtitleLang === undefined ? {} : { subtitleLang }),
    }
  }

  private async getComments(aid: number): Promise<unknown> {
    const url = `${REPLY_URL}?type=1&oid=${aid}&sort=2&pn=1&ps=20`
    try {
      return await this.getJson<unknown>(url, {}, true)
    } catch (err) {
      // 登录态失效时退回匿名，不让整条观察失败。
      if (this.auth !== null && err instanceof BilibiliError && err.code === -101) {
        return this.getJson<unknown>(url)
      }
      throw err
    }
  }

  private fetchSubtitle(bvid: string, cid: number): Promise<{ text: string; lang: string } | null> {
    return fetchBilibiliSubtitle(
      {
        getJson: <T>(url: string, headers?: Record<string, string>, useAuth?: boolean) =>
          this.getJson<T>(url, headers, useAuth),
        fetchJson: this.fetchJsonImpl,
        policy: this.policy,
        headers: () => this.headers(),
        throttle: this.throttle,
        wbiMixin: () => this.wbiMixin(),
        now: this.now,
      },
      bvid,
      cid,
    )
  }

  private async wbiMixin(): Promise<string> {
    if (this.wbiCache !== null && this.now() - this.wbiCache.at < NAV_TTL_MS) {
      return this.wbiCache.mixin
    }
    await this.throttle()
    const res = await this.fetchJsonImpl<unknown>(NAV_URL, this.policy, {
      headers: this.headers(),
      maxBytes: 256 * 1024,
    })
    const keys = parseWbiNav(res.json)
    if (keys === null) throw new Error('WBI nav 缺少 wbi_img')
    const mixin = mixinKey(keys.imgKey, keys.subKey)
    this.wbiCache = { mixin, at: this.now() }
    return mixin
  }

  private async buvidCookie(): Promise<string> {
    if (this.buvidCache !== null && this.now() - this.buvidCache.at < BUVID_TTL_MS) {
      return this.buvidCache.cookie
    }
    await this.throttle()
    const res = await this.fetchJsonImpl<unknown>(BUVID_URL, this.policy, {
      headers: this.headers(),
      maxBytes: 64 * 1024,
    })
    const buvid = parseBuvid(res.json)
    if (buvid === null) throw new Error('匿名 buvid 获取失败')
    const cookie = `buvid3=${buvid.buvid3}${buvid.buvid4 ? `; buvid4=${buvid.buvid4}` : ''}`
    this.buvidCache = { cookie, at: this.now() }
    return cookie
  }

  private async getJson<T>(
    url: string,
    extraHeaders: Record<string, string> = {},
    useAuth = false,
  ): Promise<T> {
    await this.throttle()
    const cookie = this.cookieHeader(useAuth)
    const res = await this.fetchJsonImpl<T>(url, this.policy, {
      headers: {
        ...this.headers(),
        ...(cookie === undefined ? {} : { cookie }),
        ...extraHeaders,
      },
    })
    const code = envelopeCode(res.json)
    if (res.status >= 400 || code !== 0) {
      throw new BilibiliError(
        `HTTP ${res.status} code ${code} ${url.split('?')[0]}`,
        res.status,
        code,
      )
    }
    if (res.json === null) throw new BilibiliError('empty JSON', res.status, code)
    return res.json
  }

  private async fetchDanmaku(cid: number): Promise<{ status: number; body: string }> {
    await this.throttle()
    return this.fetchPageImpl(`${DANMAKU_URL}/${cid}.xml`, this.policy)
  }

  private headers(): Record<string, string> {
    return { referer: REFERER, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }
  }

  /** 只在需要时带 SESSDATA；永不带 bili_jct（写 CSRF）。 */
  private cookieHeader(useAuth: boolean): string | undefined {
    const parts: string[] = []
    if (useAuth && this.auth !== null) parts.push(`SESSDATA=${this.auth.sessdata}`)
    if (this.buvidCache !== null) parts.push(this.buvidCache.cookie)
    return parts.length > 0 ? parts.join('; ') : undefined
  }

  private async defaultThrottle(): Promise<void> {
    const gap = 1500 + Math.floor(Math.random() * 1500)
    const wait = this.lastRequestAt + gap - this.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    this.lastRequestAt = this.now()
  }
}

