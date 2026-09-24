// @diver/self-prompt — restart_agent 工具：写标志 + 优雅退出，让壳重新拉起 sidecar。
// 与 @diver/backend 的 restart.requested 契约一致，但本插件不依赖 backend。
//
// 注意：prompts/*.md 与 skill 正文是热加载的，**改提示词不必调本工具**。
// 本工具保留给「必须重载插件代码 / 核心服务」的场景。

import type { Context } from 'cordis'
import {
  gracefulExitForRestart,
  writeRestartPending,
  writeRestartRequested,
} from './paths.ts'

export function applyRestartTool(ctx: Context): void {
  ctx.tools.register('restart_agent', async (args) => {
    const a = (args ?? {}) as { reason?: unknown }
    const reason = typeof a.reason === 'string' && a.reason.trim()
      ? a.reason.trim()
      : 'runtime reload requested'
    writeRestartPending(reason)
    writeRestartRequested(`self-prompt: ${reason}`)
    gracefulExitForRestart()
    return {
      content: JSON.stringify({
        ok: true,
        message: '正在重启 sidecar。重启完成后会收到系统事件。提示词/prompts 修改其实不必重启（热加载）。',
        reason,
      }),
    }
  }, {
    description:
      '重启 agent 运行时（sidecar）。**改 prompts/*.md 提示词不需要本工具**（下一拍热加载）。'
      + '仅在需要重载插件代码或核心服务时使用；重启完成后会注入一条「重启完成」系统事件。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么要重启（写入日志/事件，可选）' },
      },
    },
  })
}
