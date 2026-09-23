// @diver/backend — presence 日程配置持久化（CRUD 由 UI 经 /api/presence）。
//
// 调度与门控在壳（src-tauri/src/base/presence_schedule.rs）；本文件只读写
// `$COS_HOME/presence-schedule.json`，与壳共读同一文件（热生效）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cosHome } from './session-helpers.ts'

/** 单条日程。 */
export interface PresenceEntry {
  id: string
  /** "HH:mm"（24 小时制，本地时区）。 */
  time: string
  /** 主动问候提示（注入 agent 前会加 [presence] 前缀）。 */
  prompt: string
  enabled: boolean
}

export interface PresenceConfig {
  entries: PresenceEntry[]
}

function schedulePath() {
  return join(cosHome(), 'presence-schedule.json')
}

/** 读取日程配置（文件缺失/损坏 → 空列表）。 */
export function loadSchedule(): PresenceConfig {
  try {
    const raw = JSON.parse(readFileSync(schedulePath(), 'utf8'))
    if (Array.isArray(raw)) return { entries: raw }
    if (Array.isArray(raw?.entries)) return { entries: raw.entries }
    return { entries: [] }
  } catch {
    return { entries: [] }
  }
}

/** 保存日程配置（整个数组替换）。 */
export function saveSchedule(entries: PresenceEntry[]): PresenceConfig {
  const config = { entries }
  try {
    mkdirSync(cosHome(), { recursive: true })
    writeFileSync(schedulePath(), JSON.stringify(config, null, 2), 'utf8')
  } catch (err) {
    console.error('[presence] 保存日程失败:', err)
  }
  return config
}
