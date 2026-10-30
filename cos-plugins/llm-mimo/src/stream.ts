// @diver/llm-mimo — OpenAI chat-completions 流式 SSE → block-protocol StreamChunk 翻译。
//
// 与 llm-volcark/stream.ts 同构；差异（均来自 MiMo 官方 OpenAI Chat Completions 文档）：
//   - 输出预算参数叫 `max_completion_tokens`（不是 `max_tokens`），范围 [1, 131072]，
//     服务端缺省 131072——显式给定时钳到上限，避免上游 400 打断整轮；
//   - 未声明 `stream_options.include_usage`：文档未列该参数，usage 已在流式块的
//     `usage` 字段里（末块），解析侧有则记、无则略；
//   - `finish_reason` 多一个 `repetition_truncation`（检测到重复而截断），按
//     max-tokens 归类，避免半截回复被当成正常结束。

import { LlmError } from '@cos/plugin-api'
import type { GenerateOptions, StreamChunk } from '@cos/plugin-api'
import { parseSseData, translate } from '@diver/llm-openai-wire'

import { MAX_COMPLETION_TOKENS } from './config'

/** 一次 chat-completions 流式调用的参数（baseUrl 已归一化）。 */
export interface ChatStreamOpts {
  baseUrl: string
  apiKey: string
  /** 默认模型（request.model 为空时使用）。 */
  defaultModel: string
  request: GenerateOptions
}

/** 输出预算：钳到官方上限；非正数视为未指定。 */
function completionBudget(maxTokens: number | undefined): number | undefined {
  if (maxTokens === undefined || maxTokens < 1) return undefined
  return Math.min(Math.floor(maxTokens), MAX_COMPLETION_TOKENS)
}

/** POST {baseUrl}/chat/completions，流式 SSE 翻译为 StreamChunk 序列。 */
export async function* streamChat(opts: ChatStreamOpts): AsyncGenerator<StreamChunk> {
  const { request } = opts
  const model = request.model === '' ? opts.defaultModel : request.model
  const budget = completionBudget(request.maxTokens)
  const response = await fetch(`${opts.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: translate(request.messages, request.system),
      ...(request.tools !== undefined && request.tools.length > 0 ? { tools: request.tools } : {}),
      ...(budget === undefined ? {} : { max_completion_tokens: budget }),
      stream: true,
    }),
    signal: request.signal,
  })
  if (!response.ok || response.body === null) {
    const detail = await response.text().catch(() => '')
    throw new LlmError('PROVIDER_ERROR', `mimo request failed: ${response.status} ${detail}`)
  }
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let buffer = ''
  let textOpened = false
  let usageReported = false
  let rawFinish: string | undefined
  const toolBlocks = new Map<number, { id: string; name: string; arguments: string }>()
  try {
    /** 解析一行 SSE data 并产出 StreamChunk（主循环与流末残留 buffer 共用）。 */
    const consume = function* (line: string): Generator<StreamChunk> {
      const data = parseSseData(line)
      if (data === null || typeof data !== 'object') return
      // 流中段错误载荷。
      if ('error' in data) {
        const message = String((data as { error: { message?: unknown } }).error?.message ?? 'unknown error')
        throw new LlmError('PROVIDER_ERROR', `mimo stream error: ${message}`)
      }
      // usage 块：OpenAI 兼容流里中间块常带 `"usage": null`，必须用 != null
      // 判空（`null !== undefined` 为真，直接读 prompt_tokens 会炸）。
      const usage = (data as {
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null
      }).usage
      // usage 常与 finish_reason 同 chunk：先记 usage，**不能 return**，否则丢掉 rawFinish。
      if (usage != null && !usageReported) {
        usageReported = true
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
          },
        }
      }
      const topFinish = (data as { finish_reason?: string | null }).finish_reason
      if (typeof topFinish === 'string' && topFinish !== '') {
        rawFinish = topFinish
      }
      const choices = (data as {
        choices?: Array<{ delta?: unknown; finish_reason?: string | null }> | null
      }).choices
      if (!Array.isArray(choices) || choices.length === 0) return
      const choice = choices[0]
      if (choice === undefined) return
      // finish_reason 可能出现在任意 choice（含空 delta 的收尾块）。
      for (const c of choices) {
        if (typeof c.finish_reason === 'string' && c.finish_reason !== '') {
          rawFinish = c.finish_reason
        }
      }
      if (typeof choice.delta !== 'object' || choice.delta === null) return
      const delta = choice.delta as {
        content?: string
        reasoning_content?: string
        reasoning?: string
        tool_calls?: Array<{
          index?: number
          id?: string
          function?: { name?: string; arguments?: string }
        }>
      }
      const thinking =
        typeof delta.reasoning_content === 'string' && delta.reasoning_content !== ''
          ? delta.reasoning_content
          : typeof delta.reasoning === 'string' && delta.reasoning !== ''
            ? delta.reasoning
            : ''
      if (thinking !== '') {
        yield { type: 'thinking-delta', text: thinking }
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        if (!textOpened) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          textOpened = true
        }
        yield { type: 'text-delta', index: 0, text: delta.content }
      }
      for (const call of delta.tool_calls ?? []) {
        const blockIndex = (call.index ?? 0) + 1
        const block = toolBlocks.get(blockIndex) ?? { id: '', name: '', arguments: '' }
        const firstForBlock = !toolBlocks.has(blockIndex)
        block.id += call.id ?? ''
        block.name += call.function?.name ?? ''
        block.arguments += call.function?.arguments ?? ''
        toolBlocks.set(blockIndex, block)
        if (firstForBlock) yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: blockIndex,
          id: call.id ?? '',
          name: call.function?.name ?? '',
          argumentsDelta: call.function?.arguments ?? '',
        }
      }
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        yield* consume(line.trim())
      }
    }
    // 流末尾：flush 解码器 + 处理残留 buffer（最后一行 SSE 往往没有尾换行，不处理会丢掉正文尾巴）。
    buffer += decoder.decode()
    for (const line of buffer.split('\n')) {
      const trimmed = line.trim()
      if (trimmed !== '') yield* consume(trimmed)
    }
    buffer = ''
    if (textOpened) yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
    for (const index of [...toolBlocks.keys()].sort((a, b) => a - b)) {
      const block = toolBlocks.get(index)
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: block?.id ?? '',
          name: block?.name ?? '',
          arguments: block?.arguments ?? '',
        },
      }
    }
    // 契约：finish 必须是最后一个 chunk。有工具调用 → tool-calls；
    // length/max_tokens/repetition_truncation → max-tokens（不把半截回复当正常结束）。
    const reason =
      toolBlocks.size > 0
        ? ({ kind: 'tool-calls' } as const)
        : rawFinish === 'length' || rawFinish === 'max_tokens' || rawFinish === 'repetition_truncation'
          ? ({ kind: 'max-tokens' } as const)
          : ({ kind: 'stop' } as const)
    yield { type: 'finish', reason }
  } finally {
    reader.releaseLock()
  }
}
