/**
 * @cos/llm-deepseek — DeepSeek adapter registering into the @cos/llm registry:
 * serves provider "deepseek-official" with models deepseek-v4-flash / -pro.
 * Translates the loop's history into the OpenAI-compatible chat-completions
 * streaming API and SSE deltas back into the block-protocol StreamChunk.
 * The API key resolves through the @cos/credentials seam when the adapter is
 * built (in apply); a missing key fails loud with a diagnostic naming the
 * setting to fix. stream() matches the LlmAdapter contract (options only).
 * @module @cos/llm-deepseek
 */

import type { Context } from 'cordis'
import { LlmAdapter } from '@cos/llm'
import type { LlmProviderInfo, ProviderConfigDecl } from '@cos/llm'
import type { GenerateOptions, MessageContent, ModelMessage, StreamChunk } from '@cos/types'
import { LlmError } from '@cos/types'

export const name = 'llm-deepseek'
export const inject = ['llm', 'credentials']

const PROVIDER = 'deepseek-official'
const API_KEY_REF = 'deepseek.apiKey'

/** DeepSeek adapter options — content plus how the API key is sourced. */
export interface DeepSeekConfig {
  baseUrl?: string
  defaultModel?: string
  /** Exact models this adapter serves under the deepseek-official provider. */
  models?: readonly string[]
  /** Dot-path of the API key in the credentials secrets file (default deepseek.apiKey). */
  apiKeyKey?: string
  /** Fallback environment variable holding the API key, when the file source is absent. */
  apiKeyEnv?: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

function contentToText(content: MessageContent): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Translate our model-visible history into the wire format, with any system prompt first. */
function translate(messages: readonly ModelMessage[], system?: string): ChatMessage[] {
  const wire: ChatMessage[] = system === undefined ? [] : [{ role: 'system', content: system }]
  for (const message of messages) {
    const text = contentToText(message.content)
    if (message.role === 'user') {
      wire.push({ role: 'user', content: text })
    } else if (message.role === 'tool') {
      wire.push({ role: 'tool', tool_call_id: message.callId ?? '', content: text })
    } else {
      const toolCalls = message.content
        .filter((block) => block.type === 'tool-call')
        .map((block) => ({
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: block.arguments },
        }))
      wire.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      })
    }
  }
  return wire
}

/** Parse one SSE `data:` payload; null for keep-alives and the [DONE] marker. */
function parseSseData(line: string): unknown | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return null
  return JSON.parse(payload) as unknown
}

class DeepSeekLlmAdapter extends LlmAdapter {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly models: readonly string[]
  private readonly defaultModel: string
  private readonly apiKeyRef: string
  private readonly apiKeyEnv: string | undefined

  constructor(credentials: Context['credentials'], config: DeepSeekConfig) {
    super()
    this.baseUrl = (config.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
    this.models = config.models ?? ['deepseek-v4-flash', 'deepseek-v4-pro']
    this.defaultModel = config.defaultModel ?? 'deepseek-v4-flash'
    this.apiKeyRef = config.apiKeyKey ?? API_KEY_REF
    this.apiKeyEnv = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
    // Credential resolution is deliberately NON-fail-loud at construction:
    // the adapter must be mountable before the user has configured an API key
    // (packaged first-run). An unresolved key yields '' here; the backend's
    // isConfigured() guard blocks chat until it is set, and stream() surfaces
    // a provider error if a request somehow goes out keyless.
    let key = ''
    try {
      key = credentials.get(this.apiKeyRef)
    } catch {
      key = process.env[this.apiKeyEnv ?? ''] ?? ''
    }
    this.apiKey = key
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
  }

  /** Adapter-owned configuration surface: the settings panel renders this
   * API-key field (and checks `configured` through the credentials seam). */
  providerConfig(provider: string): ProviderConfigDecl {
    return {
      provider,
      name: 'DeepSeek（官方）',
      description: 'DeepSeek 官方 API（deepseek-v4-flash / deepseek-v4-pro）。',
      fields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          secret: true,
          store: 'credentials',
          credentialRef: this.apiKeyRef,
          envKey: this.apiKeyEnv,
          required: true,
          placeholder: 'sk-…',
          hint: `存于 secrets 文件（${this.apiKeyRef}）${this.apiKeyEnv === undefined ? '' : `，环境变量 ${this.apiKeyEnv} 兜底`}`,
        },
        {
          key: 'baseUrl',
          label: 'API Base URL',
          type: 'text',
          store: 'settings',
          required: false,
          placeholder: 'https://api.deepseek.com',
          hint: '留空用官方端点；自定义（如中转/代理）时填写，保存后热生效（无需重启）。清空并保存即恢复默认。',
        },
      ],
    }
  }

  async listModels(provider: string): Promise<readonly string[]> {
    if (provider !== PROVIDER) return []
    return this.models
  }

  async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    const model = request.model === '' ? this.defaultModel : request.model
    // 运行时 baseUrl：优先 settings UI 写入的 <provider>.baseUrl（热生效），否则构造期默认。
    const baseUrl = (this.settingsValue(PROVIDER, 'baseUrl') ?? this.baseUrl).replace(/\/+$/, '')
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: translate(request.messages, request.system),
        ...(request.tools !== undefined && request.tools.length > 0 ? { tools: request.tools } : {}),
        stream: true,
      }),
      signal: request.signal,
    })
    if (!response.ok || response.body === null) {
      throw new LlmError('PROVIDER_ERROR', `deepseek request failed: ${response.status} ${await response.text()}`)
    }
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    let textOpened = false
    const toolBlocks = new Map<number, { id: string; name: string; arguments: string }>()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const data = parseSseData(line.trim())
          if (data === null || typeof data !== 'object' || !('choices' in data)) continue
          const choice = (data as { choices: Array<{ delta: unknown }> }).choices[0]
          if (choice === undefined || typeof choice.delta !== 'object') continue
          const delta = choice.delta as { content?: string; tool_calls?: Array<{
            index?: number
            id?: string
            function?: { name?: string; arguments?: string }
          }> }
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
      }
      if (textOpened) yield { type: 'block-end', index: 0, block: { type: 'text', text: '' } }
      for (const index of [...toolBlocks.keys()].sort((a, b) => a - b)) {
        const block = toolBlocks.get(index)
        yield { type: 'block-end', index, block: { type: 'tool-call', id: block?.id ?? '', name: block?.name ?? '', arguments: block?.arguments ?? '' } }
      }
      // 契约：finish 必须是最后一个 chunk（与 mock-llm / commandcode 一致）。
      yield { type: 'finish', reason: { kind: toolBlocks.size > 0 ? 'tool-calls' : 'stop' } }
    } finally {
      reader.releaseLock()
    }
  }
}

export function apply(ctx: Context, config: DeepSeekConfig = {}) {
  // Register the credential source, then resolve it by building the adapter.
  // The key comes from the @cos/credentials secrets file (key deepseek.apiKey by
  // default), with an environment fallback (DEEPSEEK_API_KEY by default); a
  // missing key fails the load with a clear diagnostic.
  const envKey = config.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  ctx.credentials.provide(API_KEY_REF, {
    key: config.apiKeyKey ?? 'deepseek.apiKey',
    envKey,
  }, {
    ref: 'DeepSeek API key (credentials.config.file → deepseek.apiKey, or env DEEPSEEK_API_KEY)',
  })
  ctx.llm.registerAdapter([PROVIDER], new DeepSeekLlmAdapter(ctx.credentials, config))
}