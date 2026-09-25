// @diver/llm-custom — 通用 OpenAI 兼容适配器（一个自定义提供商一个实例）。
//
// 配置值全部运行时读取（settingsValue / credentials.get），保存即热生效：
//   - `<id>.baseUrl`（diver-settings）→ {baseUrl}/chat/completions
//   - `<id>.models`（diver-settings，逗号分隔）→ 模型目录（advisory）
//   - `custom.<id>.apiKey`（secrets 文件）→ Bearer 鉴权
// @module @diver/llm-custom/openai-compat

import type { Context } from 'cordis'
import { LlmAdapter, LlmError } from '@cos/plugin-api'
import type {
  GenerateOptions,
  LlmProviderInfo,
  ProviderConfigDecl,
  ResolvedModelInfo,
  StreamChunk,
} from '@cos/plugin-api'

import { parseSseData, translate } from './wire.ts'

/** 凭据 ref / 环境变量命名（与 backend custom-providers.ts 写入端一致）。 */
export function apiKeyRefOf(provider: string): string {
  return `custom.${provider}.apiKey`
}

export function apiKeyEnvOf(provider: string): string {
  return `CUSTOM_API_KEY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

export class OpenAICompatAdapter extends LlmAdapter {
  constructor(
    private readonly provider: string,
    private readonly displayName: string,
    private readonly credentials: Context['credentials'],
  ) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.displayName }
  }

  /** 配置声明：API Key（secrets）+ Base URL / 模型列表（settings，热生效）。 */
  providerConfig(provider: string): ProviderConfigDecl {
    return {
      provider,
      name: this.displayName,
      description: '自定义 OpenAI 兼容端点（中转 / 代理 / 自建网关）。模型目录手填，或在添加表单里一键拉取。',
      fields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          secret: true,
          store: 'credentials',
          credentialRef: apiKeyRefOf(provider),
          envKey: apiKeyEnvOf(provider),
          required: true,
          placeholder: '…',
          hint: `端点签发的 API Key，存于 secrets 文件（${apiKeyRefOf(provider)}），环境变量 ${apiKeyEnvOf(provider)} 兜底。保存后热生效。`,
        },
        {
          key: 'baseUrl',
          label: 'API Base URL',
          type: 'text',
          store: 'settings',
          required: true,
          placeholder: 'https://api.openai.com/v1',
          hint: 'OpenAI 兼容根地址（一般含 /v1）。聊天请求发往 {Base URL}/chat/completions，模型拉取发往 {Base URL}/models。保存后热生效。',
        },
        {
          key: 'models',
          label: '模型 ID 列表',
          type: 'text',
          store: 'settings',
          required: true,
          placeholder: 'gpt-4o-mini, gpt-4o',
          hint: '逗号分隔模型 id。目录 advisory，不在列表里的 id 也能用。保存后热生效。',
        },
      ],
    }
  }

  /** 模型目录：settings 里手填的逗号分隔列表（advisory，零网络）。 */
  async listModels(provider: string): Promise<readonly string[]> {
    if (provider !== this.provider) return []
    const raw = this.settingsValue(provider, 'models') ?? ''
    return raw
      .split(/[,\n]/)
      .map((m) => m.trim())
      .filter((m) => m !== '')
  }

  /** 解析确切模型：目录 advisory，不拦截未列出模型。 */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<ResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  /** 运行时端点：settings 热值优先；未配置显式报错（带「该配置什么」诊断）。 */
  private resolvedBaseUrl(): string {
    const base = (this.settingsValue(this.provider, 'baseUrl') ?? '').replace(/\/+$/, '')
    if (base === '') {
      throw new LlmError(
        'PROVIDER_ERROR',
        `custom provider ${this.provider}: 未配置 API Base URL（设置面板 → ${this.displayName} 填写，保存后热生效）`,
      )
    }
    return base
  }

  /** 惰性解析 API key：未配置时抛出带诊断的 LlmError。 */
  private requireApiKey(): string {
    try {
      return this.credentials.get(apiKeyRefOf(this.provider))
    } catch (error) {
      throw new LlmError(
        'PROVIDER_ERROR',
        `custom provider ${this.provider}: ${(error as Error).message}（设置面板 → ${this.displayName} 配置 API Key，或设 ${apiKeyEnvOf(this.provider)}）`,
      )
    }
  }

  async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    const fallback = (await this.listModels(this.provider))[0] ?? ''
    const model = request.model === '' ? fallback : request.model
    const response = await fetch(`${this.resolvedBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.requireApiKey()}`,
      },
      body: JSON.stringify({
        model,
        messages: translate(request.messages, request.system),
        ...(request.tools !== undefined && request.tools.length > 0 ? { tools: request.tools } : {}),
        // 通用端点对 max_tokens 上限各异：仅在调用方显式给定时下发，
        // 避免超限被 400；截断由 finish=max-tokens 兜底。
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    })
    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '')
      throw new LlmError(
        'PROVIDER_ERROR',
        `custom provider ${this.provider} request failed: ${response.status} ${detail}`,
      )
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
          throw new LlmError('PROVIDER_ERROR', `custom provider stream error: ${message}`)
        }
        // usage 常与 finish_reason 同 chunk：先记 usage，**不能 return**，否则丢掉 rawFinish。
        const usage = (data as {
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null
        }).usage
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
      // 流末尾：flush 解码器 + 处理残留 buffer（最后一行 SSE 往往没有尾换行）。
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
      // 契约：finish 必须是最后一个 chunk；length/max_tokens → max-tokens。
      const reason =
        toolBlocks.size > 0
          ? ({ kind: 'tool-calls' } as const)
          : rawFinish === 'length' || rawFinish === 'max_tokens'
            ? ({ kind: 'max-tokens' } as const)
            : ({ kind: 'stop' } as const)
      yield { type: 'finish', reason }
    } finally {
      reader.releaseLock()
    }
  }
}
