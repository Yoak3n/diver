// @diver/backend — 纯函数助手（不依赖框架服务）：COS_HOME、设置文件读写。
//
// 两份设置文件的边界（保持 cos 层独立性）：
// - diver-settings.json：diver 自有状态（provider / model / petInteraction 等非带点键）。
// - cos-settings.json：cos 框架契约文件，provider 配置通道 `<provider>.<key>` 写这里
//   （@cos/llm 的 LlmAdapter.settingsValue 只认此文件，diver 作为适配方迁就契约）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 当前进程的 cos home（sidecar 启动时由 Rust 注入 COS_HOME）。 */
export function cosHome() {
  return process.env.COS_HOME ?? join(process.cwd(), '.cos-home')
}

/** Diver 自身偏好（provider/model 选择、petInteraction 等）持久化文件。 */
function diverSettingsPath() {
  return join(cosHome(), 'diver-settings.json')
}

/** cos 框架契约设置文件（provider 配置通道 `<provider>.<key>`）。 */
function cosSettingsPath() {
  return join(cosHome(), 'cos-settings.json')
}

/** 读 JSON 设置文件；容忍 Windows 记事本/PowerShell 写入的 UTF-8 BOM（否则整文件被静默忽略）。 */
function readJsonFile(path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

export function readDiverSettings(): Record<string, any> {
  return readJsonFile(diverSettingsPath())
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

export function readCosSettings(): Record<string, any> {
  return readJsonFile(cosSettingsPath())
}

export function writeCosSettings(patch: Record<string, unknown>): Record<string, any> {
  const current = readCosSettings()
  const next = { ...current, ...patch }
  try {
    mkdirSync(cosHome(), { recursive: true })
    writeFileSync(cosSettingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('[diver] 保存 provider 配置失败:', err)
  }
  return next
}

/**
 * 一次性迁移：历史版本把 provider 配置 `<provider>.<key>` 误写进 diver-settings.json，
 * 搬回契约文件 cos-settings.json。diver 自有键（provider/model/petInteraction）均不带点，
 * 「带点键」是 provider 配置通道的唯一形态，据此精确判别，不误伤。
 */
export function migrateDottedSettings(): void {
  const legacy = readDiverSettings()
  const dotted = Object.keys(legacy).filter((k) => k.includes('.'))
  if (dotted.length === 0) return
  const moved: Record<string, unknown> = {}
  for (const k of dotted) {
    moved[k] = legacy[k]
    delete legacy[k]
  }
  writeCosSettings(moved)
  try {
    writeFileSync(diverSettingsPath(), JSON.stringify(legacy, null, 2), 'utf8')
    console.log(`[diver] 迁移 provider 配置键到 cos-settings.json: ${dotted.join(', ')}`)
  } catch (err) {
    console.error('[diver] 迁移设置键失败:', err)
  }
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