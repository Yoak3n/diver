// 只读跑一次 B 站平台观察：发现 → 选 1–2 条 → 详情/弹幕/评论 → 打印 payload。
// 不登录、不评论、不点赞、不私信；仅用于本地调试端点与提炼材料。
//
// 用法：node --import tsx scripts/bilibili-observe.mjs [--query AI] [--rid 0] [--limit 2]
import { BilibiliObserver } from '../cos-plugins/memory/src/curiosity-bilibili.ts'
import { selectPlatformCandidates } from '../cos-plugins/memory/src/curiosity-platform-select.ts'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const query = arg('query', '').trim()
const rid = Number(arg('rid', '0')) || 0
const limit = Math.max(1, Math.min(2, Number(arg('limit', '2')) || 2))
const keywords = query === '' ? [] : query.split(/[\s,，]+/).filter(Boolean)

console.log(`[bili-observe] 只读会话 query=${query || '-'} rid=${rid} limit=${limit}`)
const client = new BilibiliObserver({ search: query !== '' })
const discovered = await client.discover(query === '' ? [] : [query], [rid])
console.log(`[bili-observe] 候选 ${discovered.candidates.length} risk=${discovered.risk}`)

const selected = selectPlatformCandidates(discovered.candidates, {
  keywords,
  perRun: limit,
  serendipity: 30,
  rand: () => 0.5,
})
console.log(`[bili-observe] 选中 ${selected.length}`)

for (const pick of selected) {
  const video = await client.observe(pick.item)
  console.log('\n' + '='.repeat(72))
  console.log(`[bili-observe] ${video.title}  ${video.url}`)
  console.log(`[bili-observe] 弹幕 ${video.danmakuTotal} 条 / 评论 ${video.comments.length} 条`)
  console.log('-'.repeat(72))
  console.log(
    [
      `【平台见闻·B站】${video.title}`,
      `分区：${video.category || '-'} · UP：${video.uploader || '-'}`,
      `播放：${video.view} · 弹幕：${video.danmaku} · 评论：${video.reply}`,
      `链接：${video.url}`,
      '',
      '<untrusted_content>',
      video.description ? `简介：${video.description}` : '',
      video.danmakuSample.length > 0 ? `弹幕采样：\n${video.danmakuSample.slice(0, 10).map((d) => `- ${d}`).join('\n')}` : '',
      video.comments.length > 0 ? `热门评论（已去用户名）：\n${video.comments.slice(0, 10).map((c) => `- ${c}`).join('\n')}` : '',
      '</untrusted_content>',
    ]
      .filter((line) => line !== '')
      .join('\n')
      .slice(0, 2500),
  )
}
console.log('\n[bili-observe] 完成（只读，无任何写请求）')
