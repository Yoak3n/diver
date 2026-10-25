// @diver/onebot — 出站图片：近期图片句柄缓存 + image 参数解析/段构造（纯逻辑）。
//
// agent 在 QQ 回合里拿不到本机文件（read/sh/screenshot 均硬禁），能发出去的图只有
// 两种来源：会话里近期收到过的图（句柄引用，桌面端收的图也能转发到 QQ），以及
// http(s) 直链（实现侧自行拉取）。句柄由 session 事件统一喂入缓存（index.ts 接线），
// `image="list"` 或传错句柄会返回可用清单——模型自描述自纠，不占提示词。

import type { Segment } from './protocol.ts'
import { maskOutbound } from './mask.ts'
import type { ResolvedConfig } from './config.ts'

/** 缓存条目（data 为 base64，不含前缀）。 */
export interface CachedImage {
  handle: string
  mime: string
  data: string
  name?: string
  /** 来源标签（onebot:g123:456 / desktop）。 */
  from: string
  /** 毫秒。 */
  at: number
}

/** 近期图片缓存：定长 + TTL，句柄单调递增（img-1、img-2…）。 */
export class RecentImages {
  private seq = 0
  private readonly items: CachedImage[] = []

  constructor(
    private readonly max = 8,
    private readonly ttlMs = 30 * 60_000,
  ) {}

  add(img: { mime: string; data: string; name?: string }, from: string, now = Date.now()): string {
    this.seq += 1
    const handle = `img-${this.seq}`
    this.items.push({ handle, ...img, from, at: now })
    while (this.items.length > this.max) this.items.shift()
    return handle
  }

  resolve(token: string, now = Date.now()): CachedImage | undefined {
    const seq = Number(token.replace(/^img-?/i, ''))
    if (!Number.isInteger(seq) || seq <= 0) return undefined
    this.sweep(now)
    return this.items.find((it) => it.handle === `img-${seq}`)
  }

  /** 过期清扫后的现存清单（新→旧）。 */
  list(now = Date.now()): CachedImage[] {
    this.sweep(now)
    return [...this.items].reverse()
  }

  private sweep(now: number): void {
    while (this.items.length > 0 && now - this.items[0].at > this.ttlMs) this.items.shift()
  }
}

/** image 参数解析结果。 */
export type ImageArg =
  | { kind: 'url'; url: string }
  | { kind: 'handle'; token: string }
  | { kind: 'list' }

/** `image` 参数 → 结构化意图；空/非字符串返回 undefined。 */
export function parseImageArg(raw: unknown): ImageArg | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value === '') return undefined
  if (value === 'list' || value === '列表') return { kind: 'list' }
  if (/^https?:\/\//i.test(value)) return { kind: 'url', url: value }
  return { kind: 'handle', token: value }
}

/**
 * 解析后的出站图片段：URL 过遮蔽总闸（凭据/内网信息不离开本机），句柄取缓存
 * 字节转 base64://。失败返回 undefined 并由调用方把错误说明给模型。
 */
export function imageSegmentOf(
  arg: ImageArg,
  images: RecentImages,
  cfg: ResolvedConfig,
  now = Date.now(),
): { segment: Segment; info: Record<string, unknown> } | { error: string; list?: unknown } {
  if (arg.kind === 'url') {
    const masked = maskOutbound(arg.url, cfg.privacy)
    if (masked.text === '') return { error: '图片 URL 遮蔽后为空，未发送' }
    return {
      segment: { type: 'image', data: { file: masked.text } },
      info: { source: 'url', ...(masked.masked.length > 0 ? { masked: masked.masked } : {}) },
    }
  }
  if (arg.kind === 'list') {
    return { error: 'list 是查询指令不是图片来源；请从清单里选句柄', list: describeImages(images, now) }
  }
  const cached = images.resolve(arg.token, now)
  if (cached === undefined) {
    return { error: `图片句柄 ${arg.token} 无效或已过期`, list: describeImages(images, now) }
  }
  return {
    segment: { type: 'image', data: { file: `base64://${cached.data}` } },
    info: { source: cached.handle, name: cached.name ?? cached.mime, from: cached.from },
  }
}

/** image 参数在出话工具里的三态：未传 / 可发送段（随正文附图）/ 本地短路回执。 */
export type ImageOutcome =
  | { kind: 'none' }
  | { kind: 'segment'; segment: Segment; info: Record<string, unknown> }
  | { kind: 'reply'; content: string }

/** image 参数三态解析：清单/错误本地短路（不占发送配额），可发送时给段与回执信息。 */
export function resolveImageArg(raw: unknown, images: RecentImages, cfg: ResolvedConfig): ImageOutcome {
  const arg = parseImageArg(raw)
  if (arg === undefined) return { kind: 'none' }
  if (arg.kind === 'list') {
    return {
      kind: 'reply',
      content: JSON.stringify({
        images: describeImages(images),
        note: '把句柄（或 http(s) 直链）填进 image 参数即可随消息发图；本地文件路径不可直接发送。',
      }),
    }
  }
  const got = imageSegmentOf(arg, images, cfg)
  if ('error' in got) {
    return {
      kind: 'reply',
      content: JSON.stringify({ error: got.error, ...(got.list !== undefined ? { images: got.list } : {}) }),
    }
  }
  return { kind: 'segment', ...got }
}

/** 可用清单（模型自纠用）：句柄 + 名字 + 来源 + 时间。 */
export function describeImages(images: RecentImages, now = Date.now()): Array<Record<string, unknown>> {
  return images.list(now).map((it) => ({
    handle: it.handle,
    name: it.name ?? it.mime,
    from: it.from,
    at: new Date(it.at).toTimeString().slice(0, 5),
  }))
}

/** 会话 user 消息 content 里的图片块提取（喂缓存用）。 */
export function imagesInContent(content: unknown): Array<{ mime: string; data: string; name?: string }> {
  if (!Array.isArray(content)) return []
  const out: Array<{ mime: string; data: string; name?: string }> = []
  for (const b of content as Array<{ type?: unknown; mime?: unknown; data?: unknown; name?: unknown }>) {
    if (
      b?.type === 'image' && typeof b.mime === 'string' && typeof b.data === 'string' && b.data !== ''
    ) {
      out.push({ mime: b.mime, data: b.data, ...(typeof b.name === 'string' && b.name !== '' ? { name: b.name } : {}) })
    }
  }
  return out
}
