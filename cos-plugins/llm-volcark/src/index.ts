// @diver/llm-volcark — 火山方舟（Volcengine Ark）适配器（@cos/llm 注册表插件）。
//
// 适配方舟 OpenAI 兼容 API：POST {baseUrl}/chat/completions，
// Bearer API Key 鉴权，流式 SSE 与 chat-completions 对齐。
// 默认端点 https://ark.cn-beijing.volces.com/api/plan/v3（可在设置面板覆盖）。
//
// 本插件在 @cos/llm 注册表注册 provider 路由 "volcark"：
//   - providerInfo()       → 显示名「火山方舟」
//   - providerConfig()     → 设置面板配置声明（apiKey + baseUrl）
//   - listModels()         → 模型目录（静态兜底；fetchModels: true 时可拉取，advisory）
//   - stream()             → OpenAI chat-completions 流式 SSE → block-protocol StreamChunk
//   - resolveModel()       → 解析确切模型（支持模型 id 与推理接入点 ep-…）
// 与 @cos/llm-deepseek / @diver/llm-commandcode 同构。
// @module @diver/llm-volcark

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
export const name = 'llm-volcark'

/** 本插件需要的框架服务：@cos/llm 注册表 + @cos/credentials 凭据层。 */
export const inject = ['llm', 'credentials']

/** 本适配器服务的 provider 路由 id。 */
export const PROVIDER = 'volcark'

/** 默认 API 端点（方舟 OpenAI 兼容路径，含 plan 段）。 */
export const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3'

/** 凭据 ref 与 env 兜底。 */
const API_KEY_REF = 'volcark.apiKey'
const API_KEY_ENV = 'ARK_API_KEY'

/** 适配器配置（cordis.yml 的 config 段）。 */
export interface VolcArkConfig {
  /** API 端点（默认 https://ark.cn-beijing.volces.com/api/plan/v3）。 */
  baseUrl?: string
  /** 默认模型（无显式 model 时使用；默认 doubao-seed-evolving）。 */
  defaultModel?: string
  /** 静态模型目录覆盖（不设置时用内置兜底目录；advisory）。 */
  models?: readonly string[]
  /**
   * 是否实时拉取 GET /models 目录。默认 false：listModels() 直接返回静态目录
   * （零网络）。设为 true 时按需拉取并缓存，失败静默退回静态目录。
   */
  fetchModels?: boolean
  /** 凭据文件点路径（默认 volcark.apiKey）。 */
  apiKeyKey?: string
  /** 环境变量兜底（默认 ARK_API_KEY）。 */
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

class VolcArkLlmAdapter extends LlmAdapter {
  private readonly credentials: Context['credentials']
  private readonly baseUrl: string
  private readonly defaultModel: string
  private readonly staticModels: readonly string[]
  private readonly apiKeyRef: string
  private readonly apiKeyEnv: string | undefined
  private readonly catalogTimeoutMs: number
  private readonly fetchModels: boolean
  private catalogCache: readonly string[] | null = null

  constructor(credentials: Context['credentials'], config: VolcArkConfig = {}) {
    super()
    this.credentials = credentials
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.defaultModel = config.defaultModel ?? 'doubao-seed-evolving'
    this.staticModels = config.models ?? []
    this.apiKeyRef = config.apiKeyKey ?? API_KEY_REF
    this.apiKeyEnv = config.apiKeyEnv ?? API_KEY_ENV
    this.catalogTimeoutMs = config.catalogTimeoutMs ?? 10_000
    this.fetchModels = config.fetchModels ?? false
    // 惰性解析 key：boot 不失败；真正调用时若未配置，带诊断显式报错。
  }

  /** 惰性解析 API key：未配置时抛出带「该配置什么」诊断的 LlmError。 */
  private requireApiKey(): string {
    try {
      return this.credentials.get(this.apiKeyRef)
    } catch (error) {
      throw new LlmError(
        'PROVIDER_ERROR',
        `volcark: ${(error as Error).message}（设置面板 → 火山方舟 配置 API Key，或设 ${this.apiKeyEnv}）`,
      )
    }
  }

  /** 可选解析 API key（目录拉取用；未配置返回 undefined，不抛）。 */
  private optionalApiKey(): string | undefined {
    try {
      const key = this.credentials.get(this.apiKeyRef)
      return key === '' ? undefined : key
    } catch {
      return undefined
    }
  }

  /** 运行时 baseUrl：优先 settings UI 写入的 <provider>.baseUrl（热生效），否则构造期默认。 */
  private resolvedBaseUrl(): string {
    return (this.settingsValue(PROVIDER, 'baseUrl') ?? this.baseUrl).replace(/\/+$/, '')
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: '火山方舟' }
  }

  /** 适配器自有的配置声明：设置面板渲染 API Key / Base URL 并判定 configured。 */
  providerConfig(provider: string): ProviderConfigDecl {
    return {
      provider,
      name: '火山方舟（Volcengine Ark）',
      description:
        '字节跳动火山方舟：豆包 Seed / DeepSeek / GLM 等，OpenAI 兼容。Model ID 见官方模型列表；plan 端点也可用控制台短名；或推理接入点 ep-…。',
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
          placeholder: '…',
          hint: `方舟控制台 → API Key 管理 创建。存于 secrets 文件（${this.apiKeyRef}）${this.apiKeyEnv === undefined ? '' : `，环境变量 ${this.apiKeyEnv} 兜底`}`,
        },
        {
          key: 'baseUrl',
          label: 'API Base URL',
          type: 'text',
          store: 'settings',
          required: false,
          placeholder: DEFAULT_BASE_URL,
          hint: '留空用默认端点；自定义（如中转/代理/标准 /api/v3）时填写，保存后热生效（无需重启）。清空并保存即恢复默认。',
        },
      ],
    }
  }

  /**
   * 模型目录（advisory）：
   * - 配置里给了静态列表 → 用静态列表（零网络）；
   * - fetchModels: true → 按需拉取 GET /models 并缓存，失败静默退回静态目录；
   * - 否则 → 静态兜底目录（启动/设置面板零请求）。
   */
  async listModels(provider: string): Promise<readonly string[]> {
    if (provider !== PROVIDER) return []
    if (this.staticModels.length > 0) return this.staticModels
    if (!this.fetchModels) return this.fallbackModels()
    if (this.catalogCache !== null) return this.catalogCache
    try {
      const apiKey = this.optionalApiKey()
      const response = await fetch(`${this.resolvedBaseUrl()}/models`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        signal: AbortSignal.timeout(this.catalogTimeoutMs),
      })
      if (!response.ok) return this.fallbackModels()
      const body = (await response.json()) as { data?: Array<{ id?: string }> }
      const ids = (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id !== '')
      if (ids.length === 0) return this.fallbackModels()
      this.catalogCache = ids
      return ids
    } catch {
      return this.fallbackModels()
    }
  }

  /**
   * 目录拉取失败时的兜底模型（advisory）。
   * 来源：方舟官方模型列表（文本生成 / Chat API）+ plan 端点控制台短名。
   * 官方 Model ID 用于标准 `/api/v3`；`/api/plan/v3` 也可用控制台短名（如 `deepseek-v4.1-flash`）。
   * 另可填推理接入点 `ep-…`。目录会过时，未列出的 id 不拦截。
   */
  private fallbackModels(): readonly string[] {
    return [
      // 官方模型列表 · 推荐（文本生成）
      'doubao-seed-evolving',
      'doubao-seed-2-1-pro-260915',
      'doubao-seed-2-1-lite-260915',
      'doubao-seed-2-1-pro-260628',
      'doubao-seed-2-1-turbo-260628',
      // plan 端点控制台短名（与 /api/plan/v3 配套）
      'doubao-seed-2-1-turbo',
      'doubao-seed-2-0-lite',
      'doubao-seed-2-0-mini',
      'deepseek-v4.1-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'glm-5.3',
      'glm-5.3-flash',
      'kimi-k3',
      'kimi-k2.8-preview',
      'kimi-k2.7-code',
      'minimax-m3',
    ]
  }

  /** 解析确切模型：目录 advisory，不拦截未列出模型（含推理接入点 ep-…）。 */
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
        // 推理模型的 completion_tokens 含 CoT；不显式给 max_tokens 时部分网关默认很小，
        // 正文会从半截被砍（finish_reason 甚至仍是 stop）。
        max_tokens: request.maxTokens ?? 384000,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    })
    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '')
      throw new LlmError('PROVIDER_ERROR', `volcark request failed: ${response.status} ${detail}`)
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
          throw new LlmError('PROVIDER_ERROR', `volcark stream error: ${message}`)
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
      // 契约：finish 必须是最后一个 chunk。
      // 映射上游 finish_reason：length/max_tokens → max-tokens，避免半截回复被当成正常结束。
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

/** 插件激活：注册凭据来源，构建适配器，注册 provider 路由。 */
export function apply(ctx: Context, config: VolcArkConfig = {}) {
  const envKey = config.apiKeyEnv ?? API_KEY_ENV
  ctx.credentials.provide(API_KEY_REF, {
    key: config.apiKeyKey ?? 'volcark.apiKey',
    envKey,
  }, {
    ref: `Volcengine Ark API key (credentials.config.file → volcark.apiKey, or env ${envKey})`,
  })
  ctx.llm.registerAdapter([PROVIDER], new VolcArkLlmAdapter(ctx.credentials, config))
}
