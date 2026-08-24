// @diver/backend — 单会话陪伴 agent 管理（跨重启复用同一会话）。
//
// 会话 id 固定为 'diver-companion'；首次聊天时创建，之后每次启动 resume，
// 历史由 @cos/persistence 的 JSONL 持久化保存，实现"同一个陪伴者、连续的记忆"。
// 使用 harness 的 ctx.agentLoop.createAgent（resume 语义由 persistence 提供）。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { SessionId, createUserMessage } from '@cos/types'
import type { Agent, AgentHandle } from '@cos/types'

import { dshHome, readDiverSettings } from './session-helpers'

export const SESSION_ID = 'diver-companion'
const WORKSPACE_DIR = () => join(dshHome(), 'workspace')

/**
 * 确保单例陪伴 agent 存在（不存在则创建；已持久化则 resume）。
 * @returns {Promise<{agent: Agent, handle: AgentHandle | null}>}
 */
export async function ensureCompanionAgent(ctx: Context, model?: string, provider?: string) {
  const id = SessionId(SESSION_ID)
  const live = ctx.agents.get(id)
  if (live) return { agent: live, handle: null }

  // agent 创建必须显式给出 provider/model（框架不会自动套用默认模型）。
  const diver = readDiverSettings()
  const agentOptions = {
    provider: provider ?? diver.provider ?? 'deepseek-official',
    model: model ?? diver.model ?? 'deepseek-v4-flash',
  }

  try {
    mkdirSync(WORKSPACE_DIR(), { recursive: true })
  } catch { /* 忽略 */ }

  // resume: true —— 有持久化会话则恢复（陪伴记忆），否则创建新会话。
  const handle = await ctx.agentLoop.createAgent({
    sessionId: id,
    meta: { cwd: WORKSPACE_DIR() },
    agentOptions,
    resume: true,
  })
  console.log(`[diver] 陪伴会话就绪 ${SESSION_ID}`)
  return { agent: handle.agent, handle }
}

/** 构造一条用户消息。 */
export function userMessage(text: string) {
  return createUserMessage(text, { kind: 'human' })
}