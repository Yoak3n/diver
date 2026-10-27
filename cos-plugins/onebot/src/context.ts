// @diver/onebot — 群聊窗口快照与唤醒消息构造（纯函数）。
//
// 缓冲里的原始消息经 selectWindow（条数/时长/字数三限，调研参考值 40 条 /
// 30 分钟）裁出背景窗，renderWindow 渲染成人读行，formatWake 组装成进
// 会话的唤醒消息文本（首行来源章 + 触发正文 + 背景窗 + 结尾指令）。

/** 缓冲消息（buffer-store 落盘同形）。 */
export interface BufferedMessage {
  /** 毫秒。 */
  time: number
  userId: string
  name: string
  text: string
  /** OneBot message_id；0 = 非消息行。 */
  messageId: number
  /** 该条是否 @ 了我（渲染标注用）。 */
  atMe: boolean
}

export interface WindowLimits {
  maxMessages: number
  maxAgeMinutes: number
  maxChars: number
}

/**
 * 三限取先到：先按时间窗过滤，再取最新 maxMessages 条，再从新往旧累计字数
 * （超预算的旧消息让位）。返回按时间升序的窗口。
 */
export function selectWindow(messages: readonly BufferedMessage[], limits: WindowLimits): BufferedMessage[] {
  const cutoff = Date.now() - limits.maxAgeMinutes * 60_000
  const fresh = messages.filter((m) => m.time >= cutoff)
  const sliced = fresh.slice(-limits.maxMessages)
  let budget = limits.maxChars
  let keepFrom = sliced.length
  while (keepFrom > 0) {
    const cost = sliced[keepFrom - 1].text.length + 1
    if (budget - cost < 0 && keepFrom < sliced.length) break
    budget -= cost
    keepFrom -= 1
  }
  return sliced.slice(keepFrom)
}

function hhmm(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 窗口 → 背景行（`[HH:MM] 名字: 正文`；@我的行尾标注）。 */
export function renderWindow(messages: readonly BufferedMessage[]): string {
  return messages
    .map((m) => `[${hhmm(m.time)}] ${m.name}: ${m.text}${m.atMe ? '  ←@我' : ''}`)
    .join('\n')
}

/** 唤醒档位 → 首行章的触发描述。 */
export type WakeKind = 'at' | 'mention' | 'quoted' | 'owner' | 'plain' | 'private'

export interface WakeInput {
  kind: WakeKind
  /** 群聊来源：群名/群号；私聊给 null。 */
  group: { id: string; name: string } | null
  senderId: string
  senderName: string
  /** 触发消息正文（已段化转文本）。 */
  text: string
  /** 普通档没有单条触发消息，给 null（正文为空）。 */
  isTrigger: boolean
  snapshot: readonly BufferedMessage[]
}

function kindLabel(kind: WakeKind): string {
  switch (kind) {
    case 'at':
      return '@了你'
    case 'mention':
      return '提到了你'
    case 'quoted':
      return '引用了你的消息'
    case 'private':
      return '私聊'
    case 'owner':
      return '说了话'
    case 'plain':
      return '正在聊天'
  }
}

function closingLine(kind: WakeKind): string {
  if (kind === 'private') {
    return '请直接回应这条私聊（调用 send_qq_private）——私聊不必沉默，如实回应即可。'
  }
  if (kind === 'owner') {
    return '主人在群里说话：与你有关或像是在对你说，就调用 send_qq_group 回应；否则调用 stay_silent 结束回合，不必强行接话。'
  }
  if (kind === 'plain') {
    return '群里在聊天，你可以插一句想说的（调用 send_qq_group），也可以调用 stay_silent 不发言后直接结束回合——不必每条都回。'
  }
  return '你在被点名，必须回应：调用 send_qq_group 回复这条消息。'
}

/**
 * 唤醒消息文本（进陪伴会话的 user/message；detail 由调用方盖 onebot: 前缀）。
 */
export function formatWake(input: WakeInput): string {
  const head =
    input.group === null
      ? `[QQ私聊 | ${input.senderName}(${input.senderId}) ${kindLabel(input.kind)}]`
      : `[QQ群 ${input.group.name}(${input.group.id}) | ${input.senderName}(${input.senderId}) ${kindLabel(input.kind)}]`
  const lines = [head]
  if (input.text !== '') lines.push(input.text)
  const rendered = renderWindow(input.snapshot)
  if (rendered !== '') {
    lines.push('', '── 近期群聊（背景，无需逐条回应）──', rendered)
  }
  lines.push('', closingLine(input.kind))
  return lines.join('\n')
}
