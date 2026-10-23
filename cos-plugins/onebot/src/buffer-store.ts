// @diver/onebot — 群聊滚动缓冲落盘（产品自有存储）。
//
// 与 group-sent.jsonl 同一原则：产品事实落产品自己的文件，不进 harness 会话
// 日志（引擎 codec 只认核心 role/事件）。每群/每私聊一份 append-only JSONL
// （`$COS_HOME/onebot/{groups,users}/<id>.jsonl`），启动时截断到最近 N 行。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { BufferedMessage } from './context.ts'

/** 当前进程的 cos home（sidecar 启动时由 Rust 注入 COS_HOME）。 */
export function cosHome(): string {
  return process.env.COS_HOME ?? join(process.cwd(), '.cos-home')
}

/** 文件 id 白名单化（群号/QQ 号；异常输入不越出目录）。 */
export function safeId(id: string): string {
  return id.replace(/[^0-9A-Za-z_-]/g, '_')
}

export function groupBufferPath(groupId: string, home: string = cosHome()): string {
  return join(home, 'onebot', 'groups', `${safeId(groupId)}.jsonl`)
}

export function privateBufferPath(userId: string, home: string = cosHome()): string {
  return join(home, 'onebot', 'users', `${safeId(userId)}.jsonl`)
}

/** 追加一条（失败只告警：缓冲是背景，不阻断消息处理）。 */
export function appendMessage(file: string, message: BufferedMessage): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(message)}\n`)
  } catch (error) {
    console.warn(`[onebot] 缓冲写入失败（不影响处理）：${String(error)}`)
  }
}

/** 读全部（文件不存在返回空；坏行跳过）。 */
export function readMessages(file: string): BufferedMessage[] {
  if (!existsSync(file)) return []
  const out: BufferedMessage[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const text = String(raw.text ?? '')
    if (text === '') continue
    out.push({
      time: Number(raw.time) || 0,
      userId: String(raw.userId ?? ''),
      name: String(raw.name ?? ''),
      text,
      messageId: Number(raw.messageId) || 0,
      atMe: raw.atMe === true,
    })
  }
  return out
}

/** 启动压缩：保留最近 keep 行重写（tmp + rename，进程中断不坏文件）。 */
export function trimBuffer(file: string, keep = 2000): void {
  if (!existsSync(file)) return
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    if (lines.length <= keep) return
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${lines.slice(-keep).join('\n')}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    console.warn(`[onebot] 缓冲压缩失败（继续追加）：${String(error)}`)
  }
}
