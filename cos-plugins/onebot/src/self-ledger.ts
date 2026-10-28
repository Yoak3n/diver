// @diver/onebot — 自己发言的记账（缓冲时间线 + 群发言落账）。
//
// 出话工具发出的消息不会以事件回声进缓冲（router.ts 丢 self_id 回声防自触发），
// 不记账的话背景窗永远缺「我说过什么」：群友对机器人消息的不带引用回应在窗口里
// 成了无头线索，会话裁剪后更是彻底失忆。因此发送成功后把实际出站的遮蔽后文本
// 写进会话缓冲（行首名字固定「我」，模型扫窗口即可辨认），时间线与群消息交织。
//
// 群发同时落 `$COS_HOME/group-sent.jsonl`（格式属主：backend/src/group-sent.ts，
// 读侧容忍未知字段）：bot 的 QQ 群发言是产品事实，落产品自己的账、不依赖会话
// 日志留存。QQ 记录带 `channel: 'onebot'` 区分；桌面群视图只显示 groups.json
// 清单里的群，QQ 群号不在其中——记录是纯审计，不会冒进任何现有视图。

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { appendMessage, cosHome, groupBufferPath, privateBufferPath } from './buffer-store.ts'
import type { BufferedMessage } from './context.ts'

/** 群发言落账文件名（与 backend/src/group-sent.ts 同名同家园；此处只追加不读）。 */
const GROUP_SENT_FILE = 'group-sent.jsonl'

/** 一次自己发言的记账输入（tools.ts 发送成功后组装）。 */
export interface SelfSendInput {
  kind: 'group' | 'private'
  /** 群号 / 对方 QQ 号。 */
  peerId: string
  /** 遮蔽后出站文本（语音形态时为合成的同一段文本）。 */
  text: string
  /** 实际以语音形态发出。 */
  voice: boolean
  /** 附图（纯图时 text 为空）。 */
  hasImage: boolean
  /** OneBot message_id；0 = 实现侧未回 id。 */
  messageId: number
}

/** 出站形态 → 缓冲/落账展示文本（对齐 protocol.ts segmentsToText 的占位记号）。 */
export function sentDisplayText(text: string, voice: boolean, hasImage: boolean): string {
  if (text === '') return '[图]'
  return voice ? `[语音] ${text}` : text
}

/**
 * 落账 clientMsgId：`ob-s-` 前缀与唤醒消息的 `ob-g*` id 空间区分
 * （backend mergeGroupSent 按 id 对账去重，撞名会误吞）。
 */
export function sentClientMsgId(groupId: string, messageId: number, time: number): string {
  return `ob-s-g${groupId}-${messageId !== 0 ? messageId : `t${time}`}`
}

/** 记账 → 缓冲行（名字固定「我」；atMe 恒 false——自己不会 @ 自己）。 */
export function selfBufferMessage(input: SelfSendInput, selfId: number, time: number): BufferedMessage {
  return {
    time,
    userId: String(selfId),
    name: '我',
    text: sentDisplayText(input.text, input.voice, input.hasImage),
    messageId: input.messageId,
    atMe: false,
  }
}

/** 群发言落账记录（backend GroupSentRecord 同形 + channel 标记）。 */
interface QqGroupSentRecord {
  text: string
  from: { id: string; name: string }
  group: { id: string; name: string }
  clientMsgId: string
  time: number
  channel: 'onebot'
}

/** 缓冲记账：写会话缓冲（时间线关键路径，失败只告警——appendMessage 已吞）。 */
export function appendSelfBuffer(send: SelfSendInput, selfId: number, home?: string): void {
  const file = send.kind === 'group'
    ? groupBufferPath(send.peerId, home ?? cosHome())
    : privateBufferPath(send.peerId, home ?? cosHome())
  appendMessage(file, selfBufferMessage(send, selfId, Date.now()))
}

/** 群发言落账：追加 `$COS_HOME/group-sent.jsonl`（失败只告警，不影响发送）。 */
export function appendGroupLedger(
  send: SelfSendInput,
  identity: { id: number; name: string },
  groupName: string,
  home?: string,
): void {
  const time = Date.now()
  const record: QqGroupSentRecord = {
    text: sentDisplayText(send.text, send.voice, send.hasImage),
    from: { id: String(identity.id), name: identity.name },
    group: { id: send.peerId, name: groupName },
    clientMsgId: sentClientMsgId(send.peerId, send.messageId, time),
    time,
    channel: 'onebot',
  }
  try {
    const file = join(home ?? cosHome(), GROUP_SENT_FILE)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(record)}\n`)
  } catch (error) {
    console.warn(`[onebot] 群发言落账失败（不影响发送）：${String(error)}`)
  }
}

export interface SelfRecorderDeps {
  /** 登录账号（get_login_info 捕获；落账署名用）。 */
  selfIdentity(): { id: number; name: string }
  /** 群名解析（router 缓存；失败兜底 `群<id>`）。 */
  groupNameOf(groupId: string): Promise<string>
  /** 测试注入落盘家园。 */
  home?: string
}

/**
 * 出话工具的记账入口。群发分两步：缓冲同步先写（不等群名 RPC，网络等待不挤歪
 * 时间线），群名解析后再落审计账。任何失败内部吞掉，绝不影响发送结果。
 */
export function createSelfRecorder(deps: SelfRecorderDeps): (send: SelfSendInput) => Promise<void> {
  return async (send) => {
    try {
      const identity = deps.selfIdentity()
      appendSelfBuffer(send, identity.id, deps.home)
      if (send.kind !== 'group') return
      let groupName = `群${send.peerId}`
      try {
        groupName = await deps.groupNameOf(send.peerId)
      } catch { /* 群名解析失败用兜底名，账不能不落 */ }
      appendGroupLedger(send, identity, groupName, deps.home)
    } catch (error) {
      console.warn(`[onebot] 自己发言记账失败（不影响发送）：${String(error)}`)
    }
  }
}
