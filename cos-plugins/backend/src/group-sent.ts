// @diver/backend — 群发言落账（**产品自有存储**）。
//
// 为什么不在 harness 会话日志里：那是引擎的通用事件流与 codec，产品事件塞进去
// 会让引擎认识产品概念（事件类型 / 落盘 role / 字段），破坏 harness↔diver 分层
// （见 AGENTS.md「harness 分层铁律」与 harness/README.md 说明）。
// 群发言落账是**产品事实**，因此落产品自己的 JSONL：`$COS_HOME/group-sent.jsonl`
// （每实例一份，与会话日志 `sessions/` 同家园、不同文件）。
//
// 语义（拍板 2026-09-27）：群视图在**发送时刻**即显示本条，不等收方领取；
// 收方稍后 claim 出的 `user/message` 副本共享 `clientMsgId`，前端合并流按 id 去重。
// 本模块只负责「记什么、怎么读回」——写入口在 routes/chat.ts（/api/group-sent），
// 历史合并入口在 routes/history.ts。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { cosHome } from './session-helpers.ts'

/** 一条已投递的群发言（发送方视角的事实记录）。 */
export interface GroupSentRecord {
  text: string
  from: { id: string; name: string }
  group: { id: string; name: string }
  clientMsgId: string
  /** 落账时刻（毫秒）：与会话日志消息合并排序用。 */
  time: number
}

/** 落账文件名（产品自有；与会话日志同家园、不同文件）。 */
export const GROUP_SENT_FILE = 'group-sent.jsonl'

/** 本实例的落账文件路径。 */
export function groupSentPath(home: string = cosHome()): string {
  return join(home, GROUP_SENT_FILE)
}

/** 追加一条落账（append-only JSONL）。失败抛给调用方决定是否吞。 */
export function appendGroupSent(file: string, record: GroupSentRecord): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`)
}

/** 读取全部落账（文件不存在返回空；坏行跳过，不阻断历史重建）。 */
export function readGroupSent(file: string): GroupSentRecord[] {
  if (!existsSync(file)) return []
  const out: GroupSentRecord[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const text = String(raw.text ?? '')
    const clientMsgId = String(raw.clientMsgId ?? '')
    // 无正文 / 无去重 id 的记录无意义，跳过
    if (text === '' || clientMsgId === '') continue
    const from = (raw.from ?? {}) as { id?: unknown; name?: unknown }
    const group = (raw.group ?? {}) as { id?: unknown; name?: unknown }
    out.push({
      text,
      from: { id: String(from.id ?? ''), name: String(from.name ?? '') },
      group: { id: String(group.id ?? '') || 'general', name: String(group.name ?? '') },
      clientMsgId,
      time: Number(raw.time) || 0,
    })
  }
  return out
}

/** 群归属字段（SSE 与历史视图同形，避免两处漂移）。 */
function groupFields(record: GroupSentRecord): Record<string, unknown> {
  const gname = record.group.name || undefined
  return {
    group: true,
    groupId: record.group.id || 'general',
    ...(gname !== undefined ? { groupName: gname } : {}),
  }
}

/** 落账 → 前端 SSE 事件（发送时刻即显示）。 */
export function groupSentEvent(
  record: GroupSentRecord,
  sessionId: string,
): Record<string, unknown> {
  return {
    type: 'message',
    kind: 'user',
    sessionId,
    messageId: record.clientMsgId,
    content: record.text,
    origin: 'peer',
    from: record.from.id,
    time: record.time,
    ...groupFields(record),
  }
}

/** 落账 → 历史视图消息（与会话日志重建出的消息同池）。 */
export function groupSentMessage(record: GroupSentRecord): Record<string, unknown> {
  return {
    id: record.clientMsgId,
    kind: 'user',
    content: record.text,
    origin: 'peer',
    from: record.from.id,
    time: record.time,
    ...groupFields(record),
  }
}

/**
 * 把落账消息并入会话日志重建出的列表：按时间升序稳定排序（同刻保持
 * 「会话日志消息在前」的相对次序），并跳过会话日志里已有同 id 的消息。
 */
export function mergeGroupSent(
  messages: Array<Record<string, unknown>>,
  records: readonly GroupSentRecord[],
): Array<Record<string, unknown>> {
  if (records.length === 0) return messages
  const seen = new Set(messages.map((message) => String(message.id ?? '')))
  const extra = records
    .filter((record) => !seen.has(record.clientMsgId))
    .map(groupSentMessage)
  if (extra.length === 0) return messages
  const merged = [...messages, ...extra]
  // Array.prototype.sort 稳定：时间相同的元素保持插入次序（会话日志先）。
  merged.sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0))
  return merged
}
