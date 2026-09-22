// @diver/backend — presence 日程调度（backend/ 子模块）。
//
// 日程提醒的持久化配置：条目存 `$COS_HOME/presence-schedule.json`（壳/UI 可读写），
// 不再硬编码在 patch 里。到点向陪伴 agent 注入 `[presence]` 主动问候（SSE 会标记
// origin=presence），并调 Rust 壳发原生通知（/rpc notify::show）。
//
// 热生效：每次 tick 重新读文件，UI 改配置无需重启 sidecar。
//
// 触发守卫：模型已配置、agent 存在、非 busy（不打断用户正在进行的对话）、
// 该条目的这一分钟未被触发过。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import type { Agent } from '@cos/plugin-api'
import { nativeRpc } from '@diver/native-bridge/rpc'

import { SESSION_ID, userMessage } from './agent.ts'
import { cosHome } from './session-helpers.ts'
import type { WebState } from './state.ts'

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

interface SchedulerDeps {
  /** 模型是否已配置（避免触发报错的空 turn）。 */
  isModelConfigured: () => Promise<boolean>
  /** 惰性确保陪伴 agent 存在。 */
  ensureAgent: () => Promise<Agent>
}

/** 启动 presence 调度器：30s tick，到点触发主动问候 + 原生通知。 */
export function startPresenceScheduler(ctx: Context, state: WebState, deps: SchedulerDeps) {
  // 已触发标记：`entryId@YYYY-MM-DD HH:mm`，防止同一分钟重复触发。
  const fired = new Set<string>()
  let firedDay = ''

  const tick = async () => {
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    // 跨天清空，避免 fired 集合随运行时长无限增长。
    if (firedDay !== dayKey) {
      fired.clear()
      firedDay = dayKey
    }

    for (const entry of loadSchedule().entries) {
      if (!entry.enabled) continue
      if (!entry.time || !entry.prompt) continue
      if (entry.time !== hhmm) continue

      const fireKey = `${entry.id}@${dayKey} ${hhmm}`
      if (fired.has(fireKey)) continue

      if (state.busy) {
        // 正在对话：不打断。同一分钟内下一次 tick（30s 后）还会再试；
        // 分钟过后本条当天不再补发（entry.time 已不匹配）。
        continue
      }
      if (!(await deps.isModelConfigured())) {
        // 模型未配置：跳过但标记，避免每 30s 都尝试
        fired.add(fireKey)
        continue
      }

      fired.add(fireKey)
      console.log(`[presence] 触发日程 ${entry.id} @ ${hhmm}: ${entry.prompt}`)

      // 1) 原生通知（壳 /rpc notify::show；失败只告警，通知可丢）
      try {
        await nativeRpc('notify::show', { title: 'Diver', body: entry.prompt })
      } catch (err) {
        console.warn('[presence] 原生通知失败:', (err as Error)?.message ?? err)
      }

      // 2) 主动问候：注入 [presence] 前缀消息 → SSE 标记 origin=presence
      try {
        const agent = await deps.ensureAgent()
        const msg = userMessage(`[presence] ${entry.prompt}`)
        agent.followup(msg)
      } catch (err) {
        console.error('[presence] 注入主动问候失败:', (err as Error)?.message ?? err)
      }
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, 30_000)

  // 启动后立即检查一次（sidecar 重启后若正好到点不落空）。
  void tick()

  // 清理：context dispose 时停掉定时器（对齐 server.ts 的 ctx.effect 习惯）。
  ctx.effect(
    () => () => {
      clearInterval(timer)
    },
    'presence:timer',
  )

  const enabled = loadSchedule().entries.filter((e) => e.enabled).length
  console.log(`[presence] 调度器就绪（${enabled} 条启用日程，30s tick）会话=${SESSION_ID}`)
}
