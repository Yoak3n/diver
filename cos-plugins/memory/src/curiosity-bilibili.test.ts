import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBilibiliPayload,
  extractSubject,
  parseComments,
  parseRanking,
  parseSearch,
  parseSubtitleBody,
  parseSubtitleTrack,
  parseView,
} from './curiosity-bilibili-parse.ts'
import { parseDanmakuXml, stripMentions } from './curiosity-bilibili-danmaku.ts'
import { extractWbiKey, mixinKey, parseBuvid, parseWbiNav, signWbiQuery } from './curiosity-bilibili-wbi.ts'

test('WBI：已知 key 向量与签名查询', () => {
  assert.equal(
    mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45'),
    'ea1db124af3c7062474693fa704f4ff8',
  )
  assert.equal(extractWbiKey('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'), '7cd084941338484aae1ad9425b84077c')
  const query = signWbiQuery({ search_type: 'video', keyword: 'AI 生活' }, 'ea1db124af3c7062474693fa704f4ff8', 1700000000)
  assert.ok(query.startsWith('keyword=AI%20%E7%94%9F%E6%B4%BB&search_type=video&wts=1700000000'))
  assert.match(query, /&w_rid=[0-9a-f]{32}$/)
  assert.notEqual(
    signWbiQuery({ keyword: 'AI' }, 'ea1db124af3c7062474693fa704f4ff8', 1700000000),
    signWbiQuery({ keyword: 'AI' }, 'ea1db124af3c7062474693fa704f4ff8', 1700000001),
  )
})

test('WBI：nav 与匿名 buvid 解析', () => {
  assert.deepEqual(
    parseWbiNav({ code: -101, data: { wbi_img: { img_url: 'https://x/a.png', sub_url: 'https://x/b.png' } } }),
    { imgKey: 'a', subKey: 'b' },
  )
  assert.deepEqual(parseBuvid({ data: { b_3: 'B3', b_4: 'B4' } }), { buvid3: 'B3', buvid4: 'B4' })
})

test('弹幕 XML：实体、去重、均匀采样', () => {
  const xml = '<i><d p="1">好耶 &amp; 起飞</d><d p="2">好耶 &amp; 起飞</d><d p="3">前方高能</d><d p="4">？？？</d></i>'
  const parsed = parseDanmakuXml(xml, 10)
  assert.equal(parsed.total, 4)
  assert.deepEqual(parsed.sample, ['好耶 & 起飞', '前方高能'])
})

test('去掉评论/弹幕里的 @用户名', () => {
  assert.equal(stripMentions('@甲 你好'), '你好')
  const parsed = parseDanmakuXml('<i><d>@乙 好耶</d></i>')
  assert.deepEqual(parsed.sample, ['好耶'])
})

test('排行/搜索/详情：关键字段与时长', () => {
  const ranking = parseRanking({
    data: {
      list: [
        {
          bvid: 'BV1xx',
          aid: 123,
          cid: 456,
          title: '【测试】一个视频',
          desc: '简介 &amp; 说明',
          owner: { name: 'UP主' },
          tname: '知识',
          duration: 600,
          stat: { view: 1000, danmaku: 50, reply: 20 },
          pubdate: 1700000000,
        },
      ],
    },
  })
  assert.equal(ranking.length, 1)
  assert.equal(ranking[0]!.title, '【测试】一个视频')
  assert.equal(ranking[0]!.description, '简介 & 说明')
  assert.equal(ranking[0]!.cid, 456)
  assert.equal(ranking[0]!.url, 'https://www.bilibili.com/video/BV1xx')

  const search = parseSearch({
    data: {
      result: [
        {
          type: 'video',
          bvid: 'BV1yy',
          aid: 1,
          title: '<em class="keyword">AI</em> 生活',
          description: 'desc',
          author: '作者',
          play: 100,
          video_review: 5,
          tag: 'AI,科技',
          pubdate: 1700000000,
          duration: '1:02:03',
        },
      ],
    },
  })
  assert.equal(search[0]!.title, 'AI 生活')
  assert.equal(search[0]!.duration, 3723)
  assert.deepEqual(search[0]!.tags, ['AI', '科技'])

  const view = parseView({
    data: {
      bvid: 'BV1zz',
      aid: 9,
      cid: 99,
      title: '标题',
      desc: '简介',
      owner: { name: 'UP' },
      tname: '科技',
      duration: 120,
      stat: { view: 1, danmaku: 2, reply: 3 },
      pubdate: 1700000000,
    },
  })
  assert.equal(view?.cid, 99)
  assert.equal(view?.category, '科技')
})

test('评论：合并置顶/普通、去用户名、实体解码', () => {
  const comments = parseComments({
    data: {
      top: [{ content: { message: '@甲 置顶评论 &amp; 内容' }, member: { uname: '甲' } }],
      upper: { top: [{ content: { message: 'UP 置顶' } }] },
      replies: [
        { content: { message: '普通评论' }, member: { uname: '乙' } },
        { content: { message: '置顶评论 & 内容' } },
      ],
    },
  })
  assert.deepEqual(comments, ['置顶评论 & 内容', 'UP 置顶', '普通评论'])
})

test('字幕轨选择与正文拼接', () => {
  const track = parseSubtitleTrack({
    data: {
      subtitle: {
        subtitles: [
          { lan: 'en', lan_doc: 'English', subtitle_url: 'https://x/en.json' },
          { lan: 'zh-CN', lan_doc: '中文', subtitle_url: '//x/sub.json' },
        ],
      },
    },
  })
  assert.deepEqual(track, { url: 'https://x/sub.json', lang: '中文' })
  assert.equal(parseSubtitleBody({ body: [{ content: '第一句' }, { content: '第二句' }] }), '第一句 第二句')
})

test('主题提取与 payload 的 untrusted 边界', () => {
  assert.equal(extractSubject('【标题】AI 与生活｜一个测试'), 'AI 与生活')
  const payload = buildBilibiliPayload(
    {
      id: 'BV1xx',
      bvid: 'BV1xx',
      aid: 1,
      cid: 2,
      title: 'AI 与生活',
      description: '简介',
      uploader: 'UP',
      category: '知识',
      duration: 600,
      view: 100,
      danmaku: 10,
      reply: 5,
      pubdate: 1700000000,
      url: 'https://www.bilibili.com/video/BV1xx',
      tags: ['AI'],
      danmakuTotal: 10,
      danmakuSample: ['好耶'],
      comments: ['我觉得很有用'],
    },
    1700000000000,
  )
  assert.ok(payload.includes('<untrusted_content>'))
  assert.ok(payload.includes('</untrusted_content>'))
  assert.ok(payload.includes('链接：https://www.bilibili.com/video/BV1xx'))
  assert.ok(payload.includes('- 好耶'))
  assert.equal(payload.includes('甲'), false)
})
