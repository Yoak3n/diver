// @diver/backend — 陪伴 agent 生命周期（单例会话，跨重启 resume）。
//
// 会话 id 固定为 'diver-companion'；首次聊天时创建，之后每次启动 resume，
// 历史由 @cos/persistence 的 JSONL 持久化保存。provider/model 不再由本插件
// 硬编码兜底：激活 provider 取自 harness 适配器注册表（ctx.llm.listProviders），
// 模型取自该 provider 适配器自己声明的目录（ctx.llm.listModels）——见 ./providers.ts。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'cordis'
import { SessionId, createUserMessage } from '@cos/plugin-api'
import type { Agent, AgentHandle } from '@cos/plugin-api'

import { cosHome, readDiverSettings } from './session-helpers.ts'
import { firstModelOf } from './providers.ts'
import type { WebState } from './state.ts'

export const SESSION_ID = 'diver-companion'
const WORKSPACE_DIR = () => join(cosHome(), 'workspace')

/**
 * 确保单例陪伴 agent 存在（不存在则创建；已持久化则 resume）。
 * provider 显式给出（设置持久化或调用方指定）时**原样采用**——即使它已不在
 * 注册表也会创建，首轮 turn 以 NO_ADAPTER 显式报错，绝不悄悄换成 mock 之类的
 * 其它适配器掩盖配置问题；只有完全未指定时才默认注册表的第一个适配器。
 * model 缺省时用该 provider 适配器目录的第一个模型（advisory）。
 * @returns {Promise<{agent: Agent, handle: AgentHandle | null}>}
 */
export async function ensureCompanionAgent(ctx: Context, model?: string, provider?: string): Promise<{ agent: Agent; handle: AgentHandle | null }> {
  const id = SessionId(SESSION_ID)
  const live = ctx.agents.get(id)
  if (live) return { agent: live, handle: null }

  const requested = provider ?? (typeof readDiverSettings().provider === 'string' ? readDiverSettings().provider : undefined)
  const resolvedProvider = requested ?? ctx.llm.listProviders()[0]?.id ?? ''
  const resolvedModel = model ?? (await firstModelOf(ctx, resolvedProvider)) ?? ''

  try {
    mkdirSync(WORKSPACE_DIR(), { recursive: true })
  } catch { /* 忽略 */ }

  // resume: true —— 有持久化会话则恢复（陪伴记忆），否则创建新会话。
  const handle = await ctx.agentLoop.createAgent({
    sessionId: id,
    meta: { cwd: WORKSPACE_DIR() },
    // maxTokens 显式下传：推理模型 completion 含 CoT，缺省会被网关砍半截正文。
    agentOptions: { provider: resolvedProvider, model: resolvedModel, maxTokens: 384000 },
    resume: true,
  })
  console.log(`[diver] 陪伴会话就绪 ${SESSION_ID}（${resolvedProvider}/${resolvedModel}）`)
  return { agent: handle.agent, handle }
}

/** 惰性确保 agent 存在并缓存到传输层状态。 */
export async function ensureAgent(ctx: Context, state: WebState) {
  if (state.agent) return state.agent
  const settings = readDiverSettings()
  const model = typeof settings.model === 'string' && settings.model ? settings.model : undefined
  const provider = typeof settings.provider === 'string' && settings.provider ? settings.provider : undefined
  const { agent, handle } = await ensureCompanionAgent(ctx, model, provider)
  state.agent = agent
  state.agentHandle = handle
  return agent
}

/** 模型/提供商切换：释放旧 agent，下次对话按新配置重建（会话记忆保留）。 */
export async function applyModelChange(ctx: Context, state: WebState, provider?: string, model?: string) {
  const agent = state.agent
  if (!model || !agent) return
  if (agent.options.provider === provider && agent.options.model === model) return
  if (state.agentHandle) {
    try {
      await state.agentHandle.dispose()
    } catch (err) {
      console.error('[diver] 释放旧 agent 失败:', err)
    }
  }
  state.agent = null
  state.agentHandle = null
}

/** 构造一条用户消息（可附带图片：base64，不含 data: 前缀）。 */
export function userMessage(
  text: string,
  images?: ReadonlyArray<{ mime: string; data: string; name?: string }>,
) {
  return createUserMessage(text, { kind: 'human' }, images)
}