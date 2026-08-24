// @diver/backend — 纯函数助手（不依赖框架服务）：DSH_HOME、diver-settings 读写。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 当前进程的 DSH_HOME（sidecar 启动时由 Rust 注入）。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(process.cwd(), '.dsh-home')
}

/** Diver 自身偏好（TTS 等）持久化文件。 */
function diverSettingsPath() {
  return join(dshHome(), 'diver-settings.json')
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
    mkdirSync(dshHome(), { recursive: true })
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