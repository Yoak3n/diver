// Diver companion — presence 插件：主动问候 / 定时提醒。
//
// 触发方式：向陪伴会话投递一条带 [presence] 标记的触发消息并唤醒 agent，
// agent 会以"主动"口吻回复（companion-web 据此把回复标记为 presence 来源）。
// 仅在陪伴会话已经存在（用户聊过天）时触发，避免在用户毫无准备时创建会话。
//
// 去重语义：
// - boot 问候：每天一次（持久化到磁盘，sidecar 重启不重复问候）
// - 定时提醒：按日期+槽位去重（内存即可，时间驱动天然不重放）

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'

import { ensureCompanionAgent, readDiverSettings, SESSION_ID, userMessage } from './session.ts'

export const name = 'diver-companion-presence'

export const inject = ['agents', 'sessions']

const CHECK_INTERVAL_MS = 30_000
const BOOT_MARK_FILE = 'presence-boot.json'

/** 读取当天是否已发过 boot 问候（跨重启持久化）。 */
function bootGreetedToday(dshHome: string): boolean {
  try {
    const file = join(dshHome, BOOT_MARK_FILE)
    if (!existsSync(file)) return false
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data?.date === new Date().toISOString().slice(0, 10)
  } catch {
    return false
  }
}

/** 标记当天已问候（写入磁盘）。 */
function markBootGreeted(dshHome: string) {
  try {
    mkdirSync(dshHome, { recursive: true })
    writeFileSync(
      join(dshHome, BOOT_MARK_FILE),
      JSON.stringify({ date: new Date().toISOString().slice(0, 10) }),
      'utf8',
    )
  } catch {
    /* 写失败不阻塞问候 */
  }
}

export function apply(ctx: Context, config: { bootGreeting?: boolean; schedule?: Array<{ hour: number; minute: number; text: string }> }) {
  const schedule = Array.isArray(config?.schedule) ? config.schedule : []
  const bootGreeting = config?.bootGreeting !== false
  const fired = new Set() // 已触发的日期+槽位（定时提醒，内存去重）

  /** 会话是否已存在（有陪伴记忆才主动开口）。 */
  function hasSession() {
    const id = SessionId(SESSION_ID)
    if (ctx.agents.get(id)) return true
    try {
      // 有持久化的会话文件（任何项目目录下存在非空内容）
      const sessionsRoot = join(process.env.DSH_HOME ?? join(process.cwd(), '.dsh-home'), 'sessions')
      if (!existsSync(sessionsRoot)) return false
      const projects = readdirSync(sessionsRoot, { withFileTypes: true })
      for (const project of projects) {
        const projectDir = join(sessionsRoot, project.name)
        const entries = project.isDirectory()
          ? readdirSync(projectDir, { withFileTypes: true })
          : []
        if (entries.some((e) => e.isDirectory())) return true
      }
    } catch {
      return false
    }
    return false
  }

  /** 投递主动消息。 */
  async function trigger(text) {
    try {
      const live = ctx.agents.get(SessionId(SESSION_ID))
      if (live) {
        live.followup(userMessage(`[presence] ${text}`))
        console.log(`[diver] presence: ${text}`)
      } else {
        // 会话存在但 agent 未创建（重启后首次）：创建/resume 后立即问候
        const settings = readDiverSettings()
        const { agent } = await ensureCompanionAgent(ctx, settings.model, settings.provider)
        agent.followup(userMessage(`[presence] ${text}`))
        console.log(`[diver] presence (new agent): ${text}`)
      }
    } catch (err) {
      console.error(`[diver] presence 触发失败: ${err?.message ?? err}`)
    }
  }

  // 启动问候：延迟到插件树稳定后执行（每天一次，跨重启持久化去重）
  if (bootGreeting) {
    setTimeout(() => {
      if (!hasSession()) return
      const dshHome = process.env.DSH_HOME ?? join(process.cwd(), '.dsh-home')
      if (bootGreetedToday(dshHome)) return
      markBootGreeted(dshHome)
      void trigger('早上好！今天过得怎么样？我一直在呢，有什么想聊的随时说。')
    }, 5000)
  }

  // 定时提醒：每 30 秒检查一次时间槽
  const timer = setInterval(() => {
    const now = new Date()
    const h = now.getHours()
    const m = now.getMinutes()
    const today = now.toISOString().slice(0, 10)
    for (const slot of schedule) {
      if (slot.hour !== h || slot.minute !== m) continue
      const key = `${today}-${slot.hour}:${slot.minute}`
      if (fired.has(key)) continue
      fired.add(key)
      if (!hasSession()) continue
      void trigger(slot.text)
    }
  }, CHECK_INTERVAL_MS)

  ctx.on('dispose', () => {
    clearInterval(timer)
  })
}
