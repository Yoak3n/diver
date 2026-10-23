// @diver/onebot — 群聊滚动缓冲落盘（产品自有存储）。
//
// 与 group-sent.jsonl 同一原则：产品事实落产品自己的文件，不进 harness 会话
// 日志（引擎 codec 只认核心 role/事件）。每群/每私聊一份 append-only JSONL
// （`$COS_HOME/onebot/{groups,users}/<id>.jsonl`）。
//
// 体积控制双管：启动时扫目录全量截断（含已不再监听的旧群文件）；运行期同一
// 文件每累计 TRIM_EVERY_APPENDS 条追加滚动截断回 BUFFER_KEEP_LINES 行——
// 背景窗只消费 30 分钟内的消息，旧行对功能无用。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { BufferedMessage } from './context.ts'

/** 当前进程的 cos home（sidecar 启动时由 Rust 注入 COS_HOME）。 */
export function cosHome(): string {
  return process.env.COS_HOME ?? join(process.cwd(), '.cos-home')
}

/** 每个缓冲文件保留的行数上限（启动与运行期截断共用）。 */
export const BUFFER_KEEP_LINES = 2000
/** 运行期动态压缩：同一文件每累计多少条追加，就截断回保留上限。 */
export const TRIM_EVERY_APPENDS = 500

const appendCounts = new Map<string, number>()

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

/**
 * 追加一条（失败只告警：缓冲是背景，不阻断消息处理）。
 * 运行期动态压缩：同一文件累计追加达到 trimEvery 条时截断回 keep 行
 * （阈值与保留行数可注入，供测试；缺省用模块常量）。
 */
export function appendMessage(
  file: string,
  message: BufferedMessage,
  opts: { keep?: number; trimEvery?: number } = {},
): void {
  const keep = opts.keep ?? BUFFER_KEEP_LINES
  const trimEvery = opts.trimEvery ?? TRIM_EVERY_APPENDS
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(message)}\n`)
    const count = (appendCounts.get(file) ?? 0) + 1
    if (count >= trimEvery) {
      appendCounts.set(file, 0)
      trimBuffer(file, keep)
    } else {
      appendCounts.set(file, count)
    }
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
export function trimBuffer(file: string, keep: number = BUFFER_KEEP_LINES): void {
  if (!existsSync(file)) return
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    if (lines.length <= keep) return
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${lines.slice(-keep).join('\n')}\n`, 'utf-8')
    renameSync(tmp, file)
  } catch (error) {
    console.warn(`[onebot] 缓冲压缩失败（继续追加）：${String(error)}`)
  }
}

/** 扫一个缓冲目录，截断其中全部 jsonl（目录不存在或读失败静默返回）。 */
function trimDir(dir: string, keep: number): void {
  if (!existsSync(dir)) return
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return
  }
  for (const file of files) {
    if (file.endsWith('.jsonl')) trimBuffer(join(dir, file), keep)
  }
}

/** 启动全量压缩：群与私聊两个目录都扫（含已不再监听的旧群/旧私聊文件）。 */
export function trimAllBuffers(home: string = cosHome(), keep: number = BUFFER_KEEP_LINES): void {
  trimDir(join(home, 'onebot', 'groups'), keep)
  trimDir(join(home, 'onebot', 'users'), keep)
}
