// @diver/self-prompt — 重启完成后的系统事件注入。
//
// apply() 时读 pending 标志；等 companion agent 起来（agent/session-start）
// 再 followup 一条 plugin 系统事件，避免 boot 时 agent 尚未创建。

import type { Context } from 'cordis'
import { createUserMessage } from '@cos/plugin-api'
import type { Agent } from '@cos/plugin-api'
import { clearRestartPending, readRestartPending } from './paths.ts'
import type { RestartPending } from './paths.ts'

/** SSE / 历史折叠标签用 detail（见 backend interaction.ts）。 */
export const RESTART_DETAIL = 'self-prompt-restart'

export function applyRestartEvent(ctx: Context): void {
  const pending: RestartPending | null = readRestartPending()
  if (pending === null) return

  const off = ctx.on('agent/session-start', (payload: { agent: Agent; source: string }) => {
    const { agent } = payload
    const reason = pending.reason ? `（原因：${pending.reason}）` : ''
    const text = `[system] 重启完成：self-prompt 提示词与 skill 已重新加载${reason}。`
      + '重启前手上没做完的活接着做完；当时正在哪个渠道对话（本地聊天 / QQ / 其它接入），'
      + '就在那个渠道把该补的进度补报给对方（外部渠道用对应的发送工具），别只在本地回话。'
    try {
      agent.followup(createUserMessage(text, { kind: 'plugin', detail: RESTART_DETAIL }))
    } catch (err) {
      console.warn('[self-prompt] 注入重启完成事件失败:', (err as Error)?.message ?? err)
    }
    clearRestartPending()
    off()
  })

  console.log(`[self-prompt] 检测到待注入的重启完成事件（${pending.at}）`)
}
