// @diver/onebot — 出站图片：近期图片句柄缓存 + image 参数解析（句柄/直链/本地路径）。
//
// 三种来源，最终都归一成 base64:// 段（不依赖 OneBot 实现端的下载能力）：
//  1. 会话里近期收到过的图（句柄引用，桌面端收的图也能转发到 QQ）；
//  2. http(s) 直链：本机取回后转发——URL 本身不离开本机，比把直链交给实现端更严；
//  3. 本地图片路径：与 read/ls/find/grep 同一文件囚笼（fs-jail，主人私聊近全开），
//     magic bytes 嗅探保证只有真图片格式能发出（挡掉把任意二进制伪装成图外带）。
// 句柄由 session 事件统一喂入缓存（index.ts 接线）；`image="list"` 或解析失败会
// 返回可用清单与写法说明——模型自描述自纠，不占提示词。

import { basename } from 'node:path'

import { resolveLocalTarget, type LocalTarget } from '@diver/basic-tools/fsio'

import type { Segment } from './protocol.ts'
import { fsVetoReason, type FsPolicy } from './fs-jail.ts'
import { fetchImageBytes, readImageFile, sniffMime, type UrlFetcher } from './img-bytes.ts'

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
  | { kind: 'path'; path: string }
  | { kind: 'list' }

/**
 * `image` 参数 → 结构化意图；空/非字符串返回 undefined。除 list / 直链 /
 * 句柄（img-N 或纯数字）外一律按本地路径处理（相对路径按 workspace 根解析，
 * 与 read 工具同语义）。
 */
export function parseImageArg(raw: unknown): ImageArg | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (value === '') return undefined
  if (value === 'list' || value === '列表') return { kind: 'list' }
  if (/^https?:\/\//i.test(value)) return { kind: 'url', url: value }
  if (/^(?:img-)?\d+$/i.test(value)) return { kind: 'handle', token: value }
  return { kind: 'path', path: value }
}

/** image 参数在出话工具里的三态：未传 / 可发送段（随正文附图）/ 本地短路回执。 */
export type ImageOutcome =
  | { kind: 'none' }
  | { kind: 'segment'; segment: Segment; info: Record<string, unknown> }
  | { kind: 'reply'; content: string }

/** image 参数解析依赖：句柄缓存 + 按当前回合现算的文件囚笼（可注入直链取回器）。 */
export interface ImageResolveDeps {
  images: RecentImages
  /** 本地路径的囚笼策略与相对路径基准（QQ 回合按来源两档；桌面回合同一基线档）。 */
  imageFs: () => Promise<{ policy: FsPolicy; workspaceBase: string }>
  /** 直链取回器；缺省真实 fetch（超时 + 大小守卫在 img-bytes）。 */
  fetchUrl?: UrlFetcher
}

const USAGE_NOTE =
  'image 参数三种写法：近期图片句柄（本清单）、http(s) 直链（本机取回后发出）、' +
  '本地图片路径（相对路径按 workspace 根解析，与 read 同界，须为真实图片文件）。'

function base64Segment(bytes: Uint8Array): Segment {
  return { type: 'image', data: { file: `base64://${Buffer.from(bytes).toString('base64')}` } }
}

/** 取回/读取失败 → 本地短路回执（不占发送配额）。 */
function replyJson(payload: Record<string, unknown>): ImageOutcome {
  return { kind: 'reply', content: JSON.stringify(payload) }
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** image 参数三态解析：清单/错误本地短路（不占发送配额），可发送时给段与回执信息。 */
export async function resolveImageArg(raw: unknown, deps: ImageResolveDeps): Promise<ImageOutcome> {
  const arg = parseImageArg(raw)
  if (arg === undefined) return { kind: 'none' }

  if (arg.kind === 'list') {
    return replyJson({ images: describeImages(deps.images), note: USAGE_NOTE })
  }

  if (arg.kind === 'handle') {
    const cached = deps.images.resolve(arg.token)
    if (cached === undefined) {
      return replyJson({
        error: `图片句柄 ${arg.token} 无效或已过期`,
        images: describeImages(deps.images),
        note: USAGE_NOTE,
      })
    }
    return {
      kind: 'segment',
      segment: { type: 'image', data: { file: `base64://${cached.data}` } },
      info: { source: cached.handle, name: cached.name ?? cached.mime, from: cached.from },
    }
  }

  if (arg.kind === 'url') {
    try {
      const bytes = await (deps.fetchUrl ?? fetchImageBytes)(arg.url)
      const mime = sniffMime(bytes)
      if (mime === undefined) {
        return replyJson({ error: '直链取回的内容不是可识别的图片（jpeg/png/gif/webp），未发送' })
      }
      return { kind: 'segment', segment: base64Segment(bytes), info: { source: 'url', url: arg.url, mime } }
    } catch (error) {
      return replyJson({ error: `直链取回失败（${errText(error)}），未发送` })
    }
  }

  // 本地路径：file:// 前缀剥掉后与 read 工具同一解析 + 囚笼判定
  const rawPath = arg.path.startsWith('file://') ? arg.path.slice('file://'.length) : arg.path
  const { policy, workspaceBase } = await deps.imageFs()
  let target: LocalTarget
  try {
    target = await resolveLocalTarget(workspaceBase, rawPath)
  } catch (error) {
    return replyJson({
      error: `图片路径无法解析（${errText(error)}）`,
      images: describeImages(deps.images),
      note: USAGE_NOTE,
    })
  }
  const veto = fsVetoReason(target.displayPath, target.targetKey, policy)
  if (veto !== undefined) return replyJson({ error: veto })
  try {
    const bytes = await readImageFile(target.targetKey)
    const mime = sniffMime(bytes)
    if (mime === undefined) {
      return replyJson({ error: `"${basename(target.displayPath)}" 不是可识别的图片文件（jpeg/png/gif/webp）` })
    }
    return {
      kind: 'segment',
      segment: base64Segment(bytes),
      info: { source: 'file', name: basename(target.displayPath), mime },
    }
  } catch (error) {
    return replyJson({ error: `读取图片失败（${errText(error)}）` })
  }
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
