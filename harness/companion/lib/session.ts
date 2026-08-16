// Diver companion — 单会话陪伴记忆管理（跨重启复用同一会话）。
//
// 会话 id 固定为 'diver-companion'；首次聊天时创建，之后每次启动 resume，
// 历史由 dsh 的 JSONL 持久化保存，实现"同一个陪伴者、连续的记忆"。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const SESSION_ID = 'diver-companion'
const WORKSPACE_DIR = () => join(dshHome(), 'workspace')

/** 当前进程的 DSH_HOME（sidecar 启动时由 Rust 注入）。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(process.cwd(), '.dsh-home')
}

/** Diver 自身偏好（TTS 等）持久化文件。 */
function diverSettingsPath() {
  return join(dshHome(), 'diver-settings.json')
}

export function readDiverSettings() {
  try {
    return JSON.parse(readFileSync(diverSettingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

export function writeDiverSettings(patch) {
  const current = readDiverSettings()
  const next = { ...current, ...patch }
  try {
    mkdirSync(dshHome(), { recursive: true })
    writeFileSync(diverSettingsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err) {
    console.error('[diver] 保存设置失败:', err)
  }
  return next
}

/**
 * 确保单例陪伴 agent 存在（不存在则创建；已持久化则 resume）。
 * @returns {Promise<{agent: import('@deepseek-ai/dsh-agent').Agent, handle: any}>}
 */
export async function ensureCompanionAgent(ctx: Context, model?: string, provider?: string) {
  const id = SessionId(SESSION_ID)
  const live = ctx.agents.get(id)
  if (live) return { agent: live, handle: null }

  // agent 创建必须显式给出 provider/model（框架不会自动套用默认模型）。
  let selection: { provider?: string; model?: string } = {}
  try {
    selection = ctx.agentDefaultModel?.currentSelection?.() ?? {}
  } catch { /* 忽略 */ }
  const agentOptions = {
    provider: provider ?? selection.provider ?? 'deepseek-official',
    model: model ?? selection.model ?? 'deepseek-v4-flash',
  }

  // 1) 尝试恢复已持久化的会话（陪伴记忆）
  try {
    const handle = await ctx.agents.resume({
      resumeSessionId: id,
      agentOptions,
    })
    console.log(`[diver] 恢复陪伴会话 ${SESSION_ID}`)
    return { agent: handle.agent, handle }
  } catch (err) {
    // 会话尚不存在（或不可恢复）→ 创建新会话
    if (String(err?.code) === 'NO_FACTORY_MESSAGE') throw err
  }

  try {
    mkdirSync(WORKSPACE_DIR(), { recursive: true })
  } catch { /* 忽略 */ }

  const handle = await ctx.agents.create({
    sessionId: id,
    meta: { cwd: WORKSPACE_DIR() },
    agentOptions,
  })
  console.log(`[diver] 创建陪伴会话 ${SESSION_ID}`)
  return { agent: handle.agent, handle }
}

/** 构造一条用户消息。 */
export function userMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** 把消息文本从内容块中取出。 */
export function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}
