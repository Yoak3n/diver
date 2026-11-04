// @diver/backend — 陪伴 agent 生命周期（单例会话，跨重启 resume）。
//
// 会话 id 固定为 'diver-companion'；组合根（companion-boot）在 boot settle 后
// 预热 resume，HTTP 聊天等入口惰性调用 ensure 兜底，历史由 @cos/persistence
// 的 JSONL 持久化保存。provider/model 不再由本插件硬编码兜底：激活 provider
// 取自 harness 适配器注册表（ctx.llm.listProviders），模型取自该 provider
// 适配器自己声明的目录（ctx.llm.listModels）——见 ./providers.ts。

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

/** 并发创建守卫：boot 预热与首个聊天请求同时到达时只建一次。finally 即清，
 * dispose 重建（applyModelChange）后不会拿到已释放的旧 promise。 */
let creating: Promise<{ agent: Agent; handle: AgentHandle | null }> | undefined

/**
 * 确保单例陪伴 agent 存在（不存在则创建；已持久化则 resume）。
 * provider 显式给出（设置持久化或调用方指定）时**原样采用**——即使它已不在
 * 注册表也会创建，首轮 turn 以 NO_ADAPTER 显式报错，绝不悄悄换成 mock 之类的
 * 其它适配器掩盖配置问题；只有完全未指定时才默认注册表的第一个适配器。
 * model 缺省时用该 provider 适配器目录的第一个模型（advisory）。
 * @returns {Promise<{agent: Agent, handle: AgentHandle | null}>}
 */
export function ensureCompanionAgent(
  ctx: Context,
  model?: string,
  provider?: string,
): Promise<{ agent: Agent; handle: AgentHandle | null }> {
  const live = ctx.agents.get(SessionId(SESSION_ID))
  if (live) return Promise.resolve({ agent: live, handle: null })
  creating ??= createCompanionAgent(ctx, model, provider).finally(() => {
    creating = undefined
  })
  return creating
}

async function createCompanionAgent(
  ctx: Context,
  model?: string,
  provider?: string,
): Promise<{ agent: Agent; handle: AgentHandle | null }> {
  const id = SessionId(SESSION_ID)
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
    // 不下发 maxTokens：deepseek/commandcode/volcark 适配器自身缺省 384000（覆盖
    // 推理模型 CoT 的 completion 预算）；opencode-go 网关会拒绝过大的 max_tokens
    // （mimo 上游直接 400），由适配器按自身协议决定是否携带。
    agentOptions: { provider: resolvedProvider, model: resolvedModel },
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

/** 构造一条用户消息（可附带图片：base64，不含 data: 前缀；
 *  `detail` 供来源归属（如群广播 'group:<gid>'）；
 *  `id` 显式指定消息身份（群广播 fan-out 共享同一 id，接收端按 id 去重）。 */
export function userMessage(
  text: string,
  images?: ReadonlyArray<{ mime: string; data: string; name?: string }>,
  detail?: string,
  id?: string,
) {
  return createUserMessage(
    text,
    detail ? { kind: 'human', detail } : { kind: 'human' },
    images,
    id,
  )
}