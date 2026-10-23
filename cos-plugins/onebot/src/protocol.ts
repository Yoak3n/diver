// @diver/onebot — OneBot 11 协议类型与消息段解析/序列化（纯函数）。
//
// 只认接入需要的子集：message 事件（group/private）、meta heartbeat/lifecycle、
// 消息段 text/at/face/image/reply/record/video/forward/json/xml。
// 实现侧（NapCat / Lagrange / LLOneBot）把 message 发成段数组或 CQ 码字符串，
// 两种形态都归一成 Segment[]；出站统一 CQ 转义。

/** OneBot 11 消息段（归一化后 data 为宽松 Record）。 */
export interface Segment {
  type: string
  data: Record<string, unknown>
}

export interface OnebotSender {
  user_id: number
  nickname?: string
  card?: string
  role?: string
}

interface OnebotEventBase {
  self_id: number
  time: number
  post_type: string
}

export interface GroupMessageEvent extends OnebotEventBase {
  post_type: 'message'
  message_type: 'group'
  message_id: number
  user_id: number
  group_id: number
  sender: OnebotSender
  message: Segment[] | string
}

export interface PrivateMessageEvent extends OnebotEventBase {
  post_type: 'message'
  message_type: 'private'
  message_id: number
  user_id: number
  sub_type?: string
  sender: OnebotSender
  message: Segment[] | string
}

export type MessageEvent = GroupMessageEvent | PrivateMessageEvent

/** 窄化收下的 WS 推送；不认识的结构返回 undefined（调用方记日志丢弃）。 */
export function parseEvent(raw: unknown): MessageEvent | MetaEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const ev = raw as Record<string, unknown>
  const postType = String(ev.post_type ?? '')
  if (postType === 'message' && (ev.message_type === 'group' || ev.message_type === 'private')) {
    return ev as unknown as MessageEvent
  }
  if (postType === 'meta_event') return ev as unknown as MetaEvent
  return undefined
}

export interface MetaEvent extends OnebotEventBase {
  post_type: 'meta_event'
  meta_event_type: string
}

// ---- CQ 码 ----

const CQ_ESCAPE: Record<string, string> = { '&': '&amp;', '[': '&#91;', ']': '&#93;' }

/** 出站文本 CQ 转义（防正文里的 [..] 被实现侧当 CQ 码解析）。 */
export function escapeCq(text: string): string {
  return text.replace(/[&[\]]/g, (ch) => CQ_ESCAPE[ch] ?? ch)
}

/**
 * CQ 码字符串 → 段数组。坏码（无闭合/空类型）按原文保留，不丢内容。
 * 只做词法切分，不校验段类型合法性。
 */
export function parseCq(text: string): Segment[] {
  const out: Segment[] = []
  let plain = ''
  const flush = () => {
    if (plain === '') return
    out.push({ type: 'text', data: { text: plain } })
    plain = ''
  }
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('[CQ:', i)
    if (start < 0) {
      plain += text.slice(i)
      break
    }
    const end = text.indexOf(']', start)
    if (end < 0) {
      plain += text.slice(i)
      break
    }
    plain += text.slice(i, start)
    const seg = parseCqBody(text.slice(start + 4, end))
    if (seg) {
      flush()
      out.push(seg)
    } else {
      plain += text.slice(start, end + 1)
    }
    i = end + 1
  }
  flush()
  return out
}

function parseCqBody(body: string): Segment | undefined {
  const [type, ...rest] = body.split(',')
  const trimmed = type.trim()
  // 段类型是 ASCII 标识符（text/at/face…）；带空格等坏码按原文保留
  if (!/^[A-Za-z_]+$/.test(trimmed)) return undefined
  const data: Record<string, unknown> = {}
  for (const pair of rest) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq).trim()
    data[key] = cqUnescape(pair.slice(eq + 1).trim())
  }
  return { type: trimmed, data }
}

function cqUnescape(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
}

/** 任意形态（段数组 / CQ 字符串）→ 段数组。 */
export function toSegments(message: Segment[] | string): Segment[] {
  if (typeof message === 'string') return parseCq(message)
  return message.filter((s) => s && typeof s.type === 'string')
}

/**
 * 段数组 → 人读文本（进缓冲 / 进模型快照用）。
 * at → @<qq 或 name>；image → [图]；face → [表情]；其余媒体/卡片给占位标记。
 */
export function segmentsToText(segments: Segment[]): string {
  const parts: string[] = []
  for (const seg of segments) {
    switch (seg.type) {
      case 'text': {
        const text = String(seg.data.text ?? '')
        if (text !== '') parts.push(text)
        break
      }
      case 'at': {
        const qq = String(seg.data.qq ?? '')
        if (qq === 'all') parts.push('@全体成员')
        else parts.push(seg.data.name !== undefined ? `@${String(seg.data.name)}` : `@${qq}`)
        break
      }
      case 'image':
        parts.push('[图]')
        break
      case 'face':
        parts.push('[表情]')
        break
      case 'record':
        parts.push('[语音]')
        break
      case 'video':
        parts.push('[视频]')
        break
      case 'forward':
        parts.push('[合并转发]')
        break
      case 'reply':
        parts.push('[回复]')
        break
      case 'json':
      case 'xml':
      case 'card':
        parts.push('[卡片]')
        break
      default:
        break
    }
  }
  return parts.join('').trim()
}

/** 群消息显示名：群名片优先，昵称兜底。 */
export function senderName(sender: OnebotSender): string {
  const card = typeof sender.card === 'string' ? sender.card.trim() : ''
  if (card !== '') return card
  const nick = typeof sender.nickname === 'string' ? sender.nickname.trim() : ''
  return nick !== '' ? nick : String(sender.user_id)
}

/** 消息里是否 @ 了指定 QQ（或 @ 全体）。 */
export function atsUser(segments: Segment[], selfId: number): boolean {
  return segments.some(
    (seg) =>
      seg.type === 'at'
      && (String(seg.data.qq ?? '') === String(selfId) || String(seg.data.qq ?? '') === 'all'),
  )
}

/** 消息是否为对指定消息的引用回复。 */
export function repliesTo(segments: Segment[], messageId: number): boolean {
  return segments.some(
    (seg) => seg.type === 'reply' && Number(seg.data.id ?? NaN) === messageId,
  )
}

/** 纯文本是否提到任一别名（不区分大小写的子串匹配）。 */
export function mentionsAlias(text: string, aliases: readonly string[]): string | undefined {
  const lower = text.toLowerCase()
  return aliases.find((alias) => alias !== '' && lower.includes(alias.toLowerCase()))
}
