// @diver/memory — 提取层：会话末消化（digest）直连 LLM 的辅助函数。
//
// 2026-08 简化：移除了逐轮快提取（extractTurn/arbitrate/mergeTopicState）。
// 记忆来源改为：① agent 主动 remember 工具；② 本文件的 digestSession
// （会话末节流消化 → 关系卡）；③ 上下文压缩的 subagent 摘要内化
// （memory/index.ts 监听 compaction/summary）。
// 所有 LLM 调用直连 ctx.llm（不进会话日志，不污染对话）。

import { createUserMessage, SessionId } from '@cos/types'
import type { Context } from 'cordis'

import { readDiverSettings } from './session.ts'

const SOURCE = { kind: 'plugin', plugin: 'diver-memory', form: 'recall' } as const

/** 从 LLM 输出中稳健提取 JSON（去代码围栏，找第一个平衡的 {...}）。 */
function parseJson(text: string | null): Record<string, any> | null {
  if (!text) return null
  const cleaned = text.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * 一次框架 LLM 调用（跟随用户在设置里选择的 provider/model，不进会话日志）。
 * @returns 文本或 null（失败静默）
 */
async function llmText(
  ctx: Context,
  options: { system: string; prompt: string; maxTokens?: number },
): Promise<string | null> {
  const diver = readDiverSettings()
  const request = {
    provider: diver.provider ?? 'deepseek-official',
    model: diver.model ?? 'deepseek-v4-flash',
    system: options.system,
    messages: [
      createUserMessage(options.prompt, SOURCE),
    ],
    maxTokens: options.maxTokens ?? 800,
    sessionId: SessionId('diver-memory-digest'),
    signal: new AbortController().signal,
  }
  let text = ''
  try {
    for await (const chunk of ctx.llm.stream(request)) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
  } catch (err) {
    console.error(`[memory] LLM 调用失败: ${(err as Error)?.message ?? err}`)
    return null
  }
  return text || null
}

const DIGEST_SYSTEM = `你是记忆消化器。基于会话摘要和统计，归纳长期模式、关系演变、认知缺口。\
高门槛保守：只有证据充分才写，不确定就不写。输出对关系卡的增量。`

/** 会话末 digest：模式/关系/缺口 → 关系卡 diff。 */
export async function digestSession(
  ctx: Context,
  card: { profile: string; agent_model: string; relationship: string },
  stats: Record<string, any>,
  transcript: string,
): Promise<Record<string, any> | null> {
  const prompt = `当前关系卡：\n【关于用户】${card.profile || '（空）'}\n【关于我】${card.agent_model || '（空）'}\n【我们之间】${card.relationship || '（空）'}\n\n统计：${JSON.stringify(stats)}\n\n本会话摘要：\n${transcript.slice(0, 2500)}\n\n输出 JSON：\n{\n  "profile": "关于用户的模式/关系/缺口（如：最近两周很忙、Lily是同事、还不知道他生日），无则省略",\n  "agent_model": "关于助手自己的模式/教训（如：被纠正过啰嗦），无则省略",\n  "relationship": "相处模式（如：报喜不报忧、喜欢轻松玩笑），无则省略"\n}`

  const raw = await llmText(ctx, { system: DIGEST_SYSTEM, prompt, maxTokens: 600 })
  return parseJson(raw)
}