// @diver/backend — 纯函数助手（不依赖框架服务）：COS_HOME、diver-settings 读写。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

/** 把消息文本从内容块中取出。兼容纯字符串 content（否则会被抽成空，前端丢用户消息）。 */
export function textOf(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** 抽出消息中的图片块（mime + base64 data + 可选文件名）。 */
export function imagesOf(blocks: unknown): Array<{ mime: string; data: string; name?: string }> {
  if (!Array.isArray(blocks)) return []
  const out: Array<{ mime: string; data: string; name?: string }> = []
  for (const b of blocks) {
    if (
      b &&
      b.type === 'image' &&
      typeof b.mime === 'string' &&
      typeof b.data === 'string' &&
      b.data !== ''
    ) {
      out.push({
        mime: b.mime,
        data: b.data,
        ...(typeof b.name === 'string' && b.name !== '' ? { name: b.name } : {}),
      })
    }
  }
  return out
}