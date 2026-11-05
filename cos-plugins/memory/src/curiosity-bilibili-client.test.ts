import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { FetchJsonResult } from '@diver/web-tools/fetch-json'
import type { WebPolicy } from '@diver/web-tools/policy'

import { BilibiliObserver, type FetchJsonLike, type FetchPageLike } from './curiosity-bilibili.ts'

const NOW = 1_700_000_000_000

function result<T>(json: unknown, status = 200): FetchJsonResult<T> {
  return {
    url: 'https://api.bilibili.com',
    finalUrl: 'https://api.bilibili.com',
    status,
    contentType: 'application/json',
    body: JSON.stringify(json),
    json: json as T,
    truncated: false,
  }
}

const ranking = {
  code: 0,
  data: {
    list: [
      {
        bvid: 'BV1rank',
        aid: 100,
        cid: 200,
        title: '榜单视频',
        desc: '榜单简介',
        owner: { name: 'UP' },
        tname: '知识',
        duration: 600,
        stat: { view: 1000, danmaku: 50, reply: 20 },
        pubdate: 1_700_000_000,
      },
    ],
  },
}

const search = {
  code: 0,
  data: {
    result: [
      {
        type: 'video',
        bvid: 'BV1search',
        aid: 101,
        title: '搜索视频',
        description: '搜索简介',
        author: '作者',
        play: 500,
        video_review: 10,
        tag: 'AI',
        pubdate: 1_700_000_000,
        duration: '10:00',
      },
    ],
  },
}

const view = {
  code: 0,
  data: {
    bvid: 'BV1rank',
    aid: 100,
    cid: 200,
    title: '榜单视频（详情）',
    desc: '完整简介',
    owner: { name: 'UP' },
    tname: '知识',
    duration: 600,
    stat: { view: 1000, danmaku: 50, reply: 20 },
    pubdate: 1_700_000_000,
  },
}

const reply = {
  code: 0,
  data: {
    top: [{ content: { message: '置顶' }, member: { uname: '甲' } }],
    replies: [{ content: { message: '普通评论' }, member: { uname: '乙' } }],
  },
}

function fakeFetchJson(seen: string[]): FetchJsonLike {
  return async <T>(url: string, _policy: WebPolicy): Promise<FetchJsonResult<T>> => {
    seen.push(url)
    if (url.includes('/nav')) {
      return result<T>({ code: -101, data: { wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } })
    }
    if (url.includes('/finger/spi')) return result<T>({ code: 0, data: { b_3: 'B3', b_4: 'B4' } })
    if (url.includes('/search/type')) return result<T>(search)
    if (url.includes('/ranking/v2')) return result<T>(ranking)
    if (url.includes('/view?')) return result<T>(view)
    if (url.includes('/reply?')) return result<T>(reply)
    throw new Error(`unexpected url ${url}`)
  }
}

const fakeFetchPage: FetchPageLike = async () => ({
  status: 200,
  body: '<i><d p="1">好耶</d><d p="2">前方高能</d></i>',
})

test('discover：排行榜 + 匿名搜索，搜索带 WBI/buvid', async () => {
  const seen: string[] = []
  const client = new BilibiliObserver({
    now: () => NOW,
    throttle: async () => {},
    fetchJsonImpl: fakeFetchJson(seen),
    fetchPageImpl: fakeFetchPage,
  })
  const found = await client.discover(['AI'], [0])
  assert.equal(found.risk, false)
  assert.deepEqual(found.candidates.map((c) => c.bvid).sort(), ['BV1rank', 'BV1search'])
  const searchUrl = seen.find((url) => url.includes('/search/type'))
  assert.ok(searchUrl !== undefined)
  assert.match(searchUrl, /w_rid=[0-9a-f]{32}/)
  assert.match(searchUrl, /wts=1700000000/)
})

test('observe：详情 + 弹幕 + 评论，失败降级', async () => {
  const seen: string[] = []
  const client = new BilibiliObserver({
    now: () => NOW,
    throttle: async () => {},
    fetchJsonImpl: fakeFetchJson(seen),
    fetchPageImpl: fakeFetchPage,
  })
  const [candidate] = (await client.discover([], [0])).candidates
  assert.ok(candidate !== undefined)
  const video = await client.observe(candidate)
  assert.equal(video.title, '榜单视频（详情）')
  assert.equal(video.danmakuTotal, 2)
  assert.deepEqual(video.danmakuSample, ['好耶', '前方高能'])
  assert.deepEqual(video.comments, ['置顶', '普通评论'])
})

test('ranking 风控 → risk=true 且不抛错', async () => {
  const client = new BilibiliObserver({
    now: () => NOW,
    throttle: async () => {},
    fetchJsonImpl: (async <T>(): Promise<FetchJsonResult<T>> =>
      result<T>({ code: -412, message: 'blocked' }, 412)) as FetchJsonLike,
    fetchPageImpl: fakeFetchPage,
  })
  const found = await client.discover(['AI'], [0])
  assert.equal(found.risk, true)
  assert.deepEqual(found.candidates, [])
})

test('评论失败不影响视频主体', async () => {
  const client = new BilibiliObserver({
    now: () => NOW,
    throttle: async () => {},
    fetchJsonImpl: (async <T>(url: string): Promise<FetchJsonResult<T>> => {
      if (url.includes('/view?')) return result<T>(view)
      if (url.includes('/reply?')) return result<T>({ code: -404 }, 404)
      return result<T>(ranking)
    }) as FetchJsonLike,
    fetchPageImpl: fakeFetchPage,
  })
  const video = await client.observe({
    id: 'BV1rank',
    bvid: 'BV1rank',
    aid: 100,
    cid: 200,
    title: '榜单视频',
    description: '',
    uploader: '',
    category: '',
    duration: 600,
    view: 1,
    danmaku: 1,
    reply: 1,
    pubdate: 0,
    url: 'https://www.bilibili.com/video/BV1rank',
    tags: [],
  })
  assert.equal(video.title, '榜单视频（详情）')
  assert.deepEqual(video.comments, [])
})

test('登录态：评论带 SESSDATA（无 bili_jct），字幕可读', async () => {
  const cookies: string[] = []
  const fetchJsonImpl: FetchJsonLike = async <T>(
    url: string,
    _policy: WebPolicy,
    opts?: { headers?: Record<string, string> },
  ): Promise<FetchJsonResult<T>> => {
    const cookie = opts?.headers?.cookie
    if (cookie !== undefined) cookies.push(cookie)
    if (url.includes('/nav')) {
      return result<T>({ code: -101, data: { wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } })
    }
    if (url.includes('/player/wbi/v2')) {
      return result<T>({
        code: 0,
        data: {
          subtitle: {
            subtitles: [{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: 'https://aisubtitle.hdslb.com/sub.json' }],
          },
        },
      })
    }
    if (url.includes('aisubtitle.hdslb.com')) {
      return result<T>({ body: [{ content: '第一句' }, { content: '第二句' }] })
    }
    if (url.includes('/view?')) return result<T>(view)
    if (url.includes('/reply?')) return result<T>(reply)
    if (url.includes('/ranking/v2')) return result<T>(ranking)
    return result<T>({})
  }
  const client = new BilibiliObserver({
    now: () => NOW,
    throttle: async () => {},
    auth: { sessdata: 'S', savedAt: 0 },
    subtitles: true,
    fetchJsonImpl,
    fetchPageImpl: fakeFetchPage,
  })
  const [candidate] = (await client.discover([], [0])).candidates
  assert.ok(candidate !== undefined)
  const video = await client.observe(candidate)
  assert.equal(video.subtitleText, '第一句 第二句')
  assert.equal(video.subtitleLang, '中文')
  const authCookies = cookies.filter((cookie) => cookie.includes('SESSDATA=S'))
  assert.ok(authCookies.length >= 2, '评论/字幕请求应带登录态')
  assert.ok(authCookies.every((cookie) => !cookie.includes('bili_jct')))
})
