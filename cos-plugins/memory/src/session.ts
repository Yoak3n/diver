// @diver/memory — 单会话陪伴记忆管理（跨重启复用同一会话）。
//
// 会话 id 固定为 'diver-companion'；首次聊天时创建，之后每次启动 resume，
// 历史由 @cos/persistence 的 JSONL 持久化保存，实现"同一个陪伴者、连续的记忆"。
// 本文件只提供纯函数助手（不依赖框架服务），供 memory 与 web 插件共用。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SESSION_ID = 'diver-companion'

/** 当前进程的 cos home（sidecar 启动时由 Rust 注入 COS_HOME）。 */
export function cosHome() {
  return process.env.COS_HOME ?? join(process.cwd(), '.cos-home')
}

/** Diver 自身偏好（TTS 等）持久化文件。 */
function diverSettingsPath() {
  return join(cosHome(), 'diver-settings.json')
}

export function readDiverSettings(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(diverSettingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

export function writeDiverSettings(patch: Record<string, unknown>): Record<string, any> {
  const current = readDiverSettings()
  const next = { ...current, ...patch }
  try {
    mkdirSync(cosHome(), { recursive: true })
    writeFileSync(diverSettingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('[diver] 保存设置失败:', err)
  }
  return next
}

/** 把消息文本从内容块中取出。 */
export function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}