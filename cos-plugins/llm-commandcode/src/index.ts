// @diver/llm-commandcode — Command Code Provider API 适配器（@cos/llm 注册表插件）。
//
// 适配 Command Code 的 Provider API（https://commandcode.ai/docs/provider）：
// 任意 OpenAI 兼容客户端可调用 https://api.commandcode.ai/provider/v1/chat/completions，
// 用同一把 Command Code API key（Studio 创建）鉴权，用量按套餐额度（GOAT / Pro /
// Max / Team / Provider）计量——GOAT 套餐 $10/月即解锁 30+ 开源/闭源模型。
//
// 本插件在 @cos/llm 注册表注册 provider 路由 "commandcode"：
//   - providerInfo()       → 显示名 "Command Code"
//   - providerConfig()     → 设置面板配置声明（apiKey 凭据字段）
//   - listModels()         → 模型目录（默认静态零网络；fetchModels: true 时实时拉取并缓存，advisory）
//   - stream()             → OpenAI chat-completions 流式 SSE → block-protocol StreamChunk
//   - resolveModel()       → 解析确切模型（目录 advisory，不拦截未列出模型）
// 与 @cos/llm-deepseek 同构，但作为第三方插件放在 cos-plugins/ 下，不进 harness 工作区。
//
// GOAT 套餐要点（见 https://commandcode.ai/docs/plans/goat）：
//   - $10/月，$14/5 小时 + $35/周 + $70/月 用量上限；
//   - 模型 id 形如 "deepseek/deepseek-v4-flash"、"Qwen/Qwen3.8-Max"（带 provider 前缀，
//     必须原样传给 API，不能去掉）；
//   - 流式请求带 stream_options.include_usage 可在末尾收到 usage 块。
// @module @diver/llm-commandcode

import type { Context } from 'cordis'
import {
  LlmAdapter,
  LlmError,
} from '@cos/plugin-api'
import type {
  GenerateOptions,
  LlmProviderInfo,
  MessageContent,
  ModelMessage,
  ProviderConfigDecl,
  ResolvedModelInfo,
  StreamChunk,
} from '@cos/plugin-api'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'llm-commandcode'

/** 本插件需要的框架服务：@cos/llm 注册表 + @cos/credentials 凭据层。 */
export const inject = ['llm', 'credentials']

/** 本适配器服务的 provider 路由 id。 */
export const PROVIDER = 'commandcode'

/** 默认 API 端点（Provider API 的 OpenAI 兼容路径）。 */
export const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1'

/** 凭据 ref 与 env 兜底。 */
const API_KEY_REF = 'commandcode.apiKey'
const API_KEY_ENV = 'COMMANDCODE_API_KEY'

/** 适配器配置（cordis.yml 的 config 段）。 */
export interface CommandCodeConfig {
  /** Provider API 端点（默认 https://api.commandcode.ai/provider/v1）。 */
  baseUrl?: string
  /** 默认模型（无显式 model 时使用；默认 deepseek/deepseek-v4-flash）。 */
  defaultModel?: string
  /** 静态模型目录覆盖（不设置时用内置兜底目录；advisory）。 */
  models?: readonly string[]
  /**
   * 是否实时拉取 /provider/v1/models 目录。默认 false：listModels() 直接返回
   * 静态目录（零网络，启动/设置面板不会触发请求）。设为 true 时按需拉取
   * 并缓存，拉取失败静默退回静态目录。
   */
  fetchModels?: boolean
  /** 凭据文件点路径（默认 commandcode.apiKey）。 */
  apiKeyKey?: string
  /** 环境变量兜底（默认 COMMANDCODE_API_KEY）。 */
  apiKeyEnv?: string
  /** 拉取 /models 目录的超时（ms）。 */
  catalogTimeoutMs?: number
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

/** 把我们的内容块压成文本（text 块拼接；tool-call 块忽略）。 */
function contentToText(content: MessageContent): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** 把模型可见历史翻译成 wire 格式（system 提示放最前）。 */
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

/** 解析一行 SSE `data:` 载荷；keep-alive 与 [DONE] 返回 null。 */
function parseSseData(line: string): unknown | null {
  if (!line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return null
  return JSON.parse(payload) as unknown
}

class CommandCodeLlmAdapter extends LlmAdapter {
  private readonly credentials: Context['credentials']
  private readonly baseUrl: string
  private readonly defaultModel: string
  private readonly staticModels: readonly string[]
  private readonly apiKeyRef: string
  private readonly apiKeyEnv: string | undefined
  private readonly catalogTimeoutMs: number
  private readonly fetchModels: boolean
  private catalogCache: readonly string[] | null = null

  constructor(credentials: Context['credentials'], config: CommandCodeConfig = {}) {
    super()
    this.credentials = credentials
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.defaultModel = config.defaultModel ?? 'deepseek/deepseek-v4-flash'
    this.staticModels = config.models ?? []
    this.apiKeyRef = config.apiKeyKey ?? API_KEY_REF
    this.apiKeyEnv = config.apiKeyEnv ?? API_KEY_ENV
    this.catalogTimeoutMs = config.catalogTimeoutMs ?? 10_000
    this.fetchModels = config.fetchModels ?? false
    // 惰性解析 key：boot 不失败；真正调用时若未配置，带诊断显式报错。
  }

  /** 惰性解析 API key：未配置时抛出带"该配置什么"诊断的 LlmError。 */
  private requireApiKey(): string {
    try {
      return this.credentials.get(this.apiKeyRef)
    } catch (error) {
      // LlmError(code, message)——按 types 的构造签名传参。
      throw new LlmError(
        'PROVIDER_ERROR',
        `commandcode: ${(error as Error).message}（设置面板 → Command Code 配置 API Key，或设 ${this.apiKeyEnv}）`,
      )
    }
  }

  /** 运行时 baseUrl：优先 settings UI 写入的 <provider>.baseUrl（热生效），否则构造期默认。 */
  private resolvedBaseUrl(): string {
    return (this.settingsValue(PROVIDER, 'baseUrl') ?? this.baseUrl).replace(/\/+$/, '')
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Command Code' }
  }

  /** 适配器自有的配置声明：设置面板渲染 API Key 字段并判定 configured。 */
  providerConfig(provider: string): ProviderConfigDecl {
    return {
      provider,
      name: 'Command Code（GOAT 套餐）',
      description:
        'Command Code Provider API：同一把 key 解锁 30+ 开源/闭源模型，用量按 GOAT 套餐额度计量。',
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
          placeholder: 'cmd_…',
          hint: `Studio → API Keys 创建。存于 secrets 文件（${this.apiKeyRef}）${this.apiKeyEnv === undefined ? '' : `，环境变量 ${this.apiKeyEnv} 兜底`}`,
        },
        {
          key: 'baseUrl',
          label: 'API Base URL',
          type: 'text',
          store: 'settings',
          required: false,
          placeholder: DEFAULT_BASE_URL,
          hint: '留空用默认端点；自定义（如中转/代理）时填写，保存后热生效（无需重启）。清空并保存即恢复默认。',
        },
      ],
    }
  }

  /**
   * 模型目录（advisory）：
   * - 配置里给了静态列表 → 用静态列表（零网络）；
   * - fetchModels: true → 按需拉取公开的 GET /provider/v1/models 并缓存，
   *   拉取失败静默退回静态目录（不打 warn 噪音——默认关闭时根本不发请求）；
   * - 否则 → 静态兜底目录（与 @cos/llm-deepseek 一致，启动/设置面板零请求）。
   */
  async listModels(provider: string): Promise<readonly string[]> {
    if (provider !== PROVIDER) return []
    if (this.staticModels.length > 0) return this.staticModels
    if (!this.fetchModels) return this.fallbackModels()
    if (this.catalogCache !== null) return this.catalogCache
    try {
      const response = await fetch(`${this.resolvedBaseUrl()}/models`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.catalogTimeoutMs),
      })
      if (!response.ok) return this.fallbackModels()
      const body = (await response.json()) as { data?: Array<{ id?: string }> }
      const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id !== '')
      if (ids.length === 0) return this.fallbackModels()
      this.catalogCache = ids
      return ids
    } catch {
      // 静默退回静态目录：目录是 advisory，不值得为它打日志。
      return this.fallbackModels()
    }
  }

  /** 目录拉取失败时的兜底模型（GOAT 套餐高频模型，advisory）。 */
  private fallbackModels(): readonly string[] {
    return [
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-pro',
      'Qwen/Qwen3.8-Max',
      'Qwen/Qwen3.7-Plus',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'google/gemini-3.7-flash',
      'xai/grok-4.6',
      'zai-org/GLM-5.2',
    ]
  }

  /** 解析确切模型：仅校验存在（目录 advisory，不拦截未列出模型）。 */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<ResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    const model = request.model === '' ? this.defaultModel : request.model
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
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    })
    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '')
      throw new LlmError('PROVIDER_ERROR', `commandcode request failed: ${response.status} ${detail}`)
    }
    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    let textOpened = false
    let usageReported = false
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
          if (data === null || typeof data !== 'object') continue
          // 非流式错误载荷（stream 中段的 error 事件）。
          if ('error' in data) {
            const message = String((data as { error: { message?: unknown } }).error?.message ?? 'unknown error')
            throw new LlmError('PROVIDER_ERROR', `commandcode stream error: ${message}`)
          }
          // usage 块：在 finish 之前发射（流结束时的 usage chunk）。
          const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
          if (usage !== undefined && !usageReported) {
            usageReported = true
            yield {
              type: 'usage',
              usage: {
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
              },
            }
            continue
          }
          if (!('choices' in data)) continue
          const choice = (data as { choices: Array<{ delta: unknown }> }).choices[0]
          if (choice === undefined || typeof choice.delta !== 'object') continue
          const delta = choice.delta as {
            content?: string
            tool_calls?: Array<{
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
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
      }
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
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      reader.releaseLock()
    }
  }
}

/** 插件激活：注册凭据来源，构建适配器，注册 provider 路由。 */
export function apply(ctx: Context, config: CommandCodeConfig = {}) {
  const envKey = config.apiKeyEnv ?? API_KEY_ENV
  ctx.credentials.provide(API_KEY_REF, {
    key: config.apiKeyKey ?? 'commandcode.apiKey',
    envKey,
  }, {
    ref: 'Command Code API key (credentials.config.file → commandcode.apiKey, or env COMMANDCODE_API_KEY)',
  })
  ctx.llm.registerAdapter([PROVIDER], new CommandCodeLlmAdapter(ctx.credentials, config))
}
