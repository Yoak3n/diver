// @diver/memory — 平台观察者的稳定契约（不依赖具体平台实现）。
//
// 适配器只做两件事：discover（发现候选）与 observe（深读一条）。
// 只读是硬约束：实现里不允许出现 POST/PUT/PATCH/DELETE。

export interface PlatformCandidate {
  /** 平台内稳定 id（B 站 = bvid）。 */
  id: string
  title: string
  description: string
  uploader: string
  category: string
  /** 秒。 */
  duration: number
  view: number
  danmaku: number
  reply: number
  pubdate: number
  url: string
  tags: string[]
}

export interface PlatformObservation extends PlatformCandidate {
  /** 用于 topic 名的短主题（LLM 的「主题：」可覆盖）。 */
  subject: string
  /** 已组装好、可直接入 curiosity_items 的正文（含 untrusted 边界）。 */
  payload: string
  danmakuTotal: number
  commentsCount: number
}

export interface PlatformDiscoverInput {
  /** 搜索词（来自 owner 兴趣，最多 2 个）。 */
  queries: string[]
  /** 排行榜分区 rid（0 = 全站）。 */
  rids: number[]
}

export interface PlatformDiscoverResult {
  candidates: PlatformCandidate[]
  /** 命中风控：本次可用兜底数据，但下次会话应退避。 */
  risk: boolean
}

export interface PlatformAdapter {
  readonly id: string
  discover(input: PlatformDiscoverInput): Promise<PlatformDiscoverResult>
  observe(candidate: PlatformCandidate): Promise<PlatformObservation>
}
