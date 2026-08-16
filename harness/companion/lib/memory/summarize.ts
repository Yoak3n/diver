// Diver companion — 压缩摘要：subagent 深读历史 + remember 工具沉淀记忆。
//
// memory 插件注册事件监听（compaction/summarize，仅携带 agent 与取消信号）
// 调用本模块；会话数据由本模块自行从 agent.session 读取——compaction 不
// 传递任何会话数据，两者零数据耦合。子代理会话（含全量历史 prompt）用完即删。

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SummaryResult } from '../types.ts'
import { dshHome } from '../session.ts'

const INSTRUCTION = `你是一名资深记忆整理员与对话压缩员。下面是用户与陪伴 agent「小潜」的一段长对话历史。

任务：
1. 通读全部对话，提炼值得长期记住的信息（用户的事实/偏好/计划/事件/双方关系变化）。
2. 使用 remember 工具写入长期记忆：
   - 每条关键事实单独调用一次 remember：content=事实的一句话描述，topic=简短话题标签（如「用户档案」「面试」「吉他」）
   - 最后调用一次 remember：content=第 3 步生成的完整摘要正文，topic=「会话历史回顾」
   - 不要使用其他任何工具；remember 失败就继续
3. 输出信息密度高的结构化摘要（分段 markdown：用户档案/重要事件/未完成事项/关系变化），
   作为最终回复直接输出摘要正文，不要开场白。`

/** 会话文本：system + 全部消息（读全部为超集；尾部在会话中仍完整保留，冗余无害）。 */
function transcriptOf(agent: Agent): string {
  const session = agent?.session
  if (!session) return ''
  const parts: string[] = []
  try {
    const header = session.requestHeader?.()
    if (header?.system) parts.push(`[system]\n${header.system}`)
    for (const seq of session.surface?.nodes ?? []) {
      const msg = session.deriveEventMessage?.(session.events[seq])
      const content = Array.isArray(msg?.content)
        ? msg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
        : String(msg?.content ?? '')
      if (content.trim()) parts.push(msg?.role ? `[${msg.role}]\n${content}` : content)
    }
  } catch (err) {
    console.warn(`[memory] 读取会话文本失败: ${err?.message ?? err}`)
  }
  return parts.join('\n\n')
}

/** 压缩摘要主流程：spawn 子代理 → remember 沉淀 → 返回摘要文本。 */
export async function summarizeWithSubagent(
  ctx: any,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const prompt = `${INSTRUCTION}\n\n<conversation>\n${transcriptOf(agent)}\n</conversation>`
  const run = await ctx.subagents.start('spawn', {
    label: 'compaction-summarizer',
    parent: agent,
    prompt: [{ type: 'text', text: prompt }],
    signal,
  })
  const result = await run.result
  scheduleChildCleanup(String(run.id))
  const text = (result?.output ?? result?.lastAssistantMessage ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('')
  if (!text.trim()) throw new Error('summarization produced no text summary content')
  // llmStreamCall 不标注（非 ctx.llm.stream 调用），rawOutput 为可选分支
  return {
    summary: [{ type: 'text', text }],
    rawOutput: [{ type: 'text', text }],
    provider: 'subagent',
    model: 'compaction-summarizer',
  }
}

// ── 子代理 session 清理（含全量历史 prompt，用完即删） ──────────────────────

const pending = new Set<string>()

function removeSessionDir(id: string): boolean {
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return false
  for (const ws of readdirSync(root)) {
    const dir = join(root, ws, id)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      return true
    }
  }
  return false
}

/** 压缩完成后延迟删除本次子代理会话（等持久化 flush 结束）。 */
function scheduleChildCleanup(id: string) {
  if (pending.has(id)) return
  pending.add(id)
  setTimeout(() => {
    pending.delete(id)
    try {
      if (removeSessionDir(id)) console.log(`[memory] 已清理子代理会话 ${id}`)
    } catch {
      /* 清理失败无害 */
    }
  }, 30_000)
}

/** 启动兜底：删除所有带 parentSession 的子代理会话（header 判据，主会话无该字段）。 */
export function cleanupSubagentSessions(): number {
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return 0
  let removed = 0
  for (const ws of readdirSync(root)) {
    for (const id of readdirSync(join(root, ws))) {
      const file = join(root, ws, id, 'session.jsonl')
      if (!existsSync(file)) continue
      try {
        const header = JSON.parse(readFileSync(file, 'utf8').split('\n')[0])
        if (typeof header?.parentSession === 'string' && header.parentSession) {
          rmSync(join(root, ws, id), { recursive: true, force: true })
          removed += 1
        }
      } catch {
        /* header 无法解析：保守跳过 */
      }
    }
  }
  return removed
}
