// @diver/llm-mimo — 小米 MiMo 开放平台适配器（@cos/llm 注册表插件）。
//
// 适配 MiMo 的 OpenAI 兼容端点（https://mimo.mi.com/docs）：
//   - 聊天 POST https://api.xiaomimimo.com/v1/chat/completions
//   - 目录 GET  https://api.xiaomimimo.com/v1/models（与聊天同 base）
//   - 鉴权支持 `Authorization: Bearer` 与 `api-key:` 两种；本适配器用 Bearer
//     （与其它 llm-* 一致）。Bearer 之外没有网关特有问题，llm-custom 其实也能接
//     ——单独成插件是为了：目录要过滤 /models 里的 TTS/ASR 型号、maxTokens 要用
//     `max_completion_tokens` 并钳到 131072（上游超限直接 400）。
//
// 本插件在 @cos/llm 注册表注册 provider 路由 "mimo"：
//   - providerInfo()       → 显示名 "MiMo"
//   - providerConfig()     → 设置面板配置声明（apiKey 凭据 + baseUrl 可选覆盖）
//   - listModels()         → 实时拉取目录（滤音频模型）并缓存，失败退回静态兜底
//   - stream()             → OpenAI chat-completions 流式 SSE → block-protocol StreamChunk
//   - resolveModel()       → 解析确切模型（目录 advisory，不拦截未列出模型）
//
// 分层：config.ts 常量/配置类型 | catalog.ts 模型目录 | stream.ts SSE 翻译；
// 本文件只做适配器装配与插件激活。
// @module @diver/llm-mimo

import type { Context } from 'cordis'
import { LlmAdapter, LlmError } from '@cos/plugin-api'
import type {
  GenerateOptions,
  LlmProviderInfo,
  ProviderConfigDecl,
  ResolvedModelInfo,
  StreamChunk,
} from '@cos/plugin-api'
import { FALLBACK_MODELS, fetchModelCatalog } from './catalog'
import {
  API_KEY_ENV,
  API_KEY_REF,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  PROVIDER,
  type MimoConfig,
} from './config'
import { streamChat } from './stream'

export { DEFAULT_BASE_URL, PROVIDER }
export type { MimoConfig }

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'llm-mimo'

/** 本插件需要的框架服务：@cos/llm 注册表 + @cos/credentials 凭据层。 */
export const inject = ['llm', 'credentials']

/** 目录缓存时长：模型更替以周计，5 分钟足够新，又不会每开一次面板就打一次上游。 */
const CATALOG_TTL_MS = 5 * 60_000

class MimoLlmAdapter extends LlmAdapter {
  private readonly credentials: Context['credentials']
  private readonly baseUrl: string
  private readonly defaultModel: string
  private readonly staticModels: readonly string[]
  private readonly apiKeyRef: string
  private readonly apiKeyEnv: string | undefined
  private readonly catalogTimeoutMs: number
  private readonly fetchModels: boolean
  private catalogCache: readonly string[] | null = null
  private catalogFetchedAt = 0

  constructor(credentials: Context['credentials'], config: MimoConfig = {}) {
    super()
    this.credentials = credentials
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.defaultModel = config.defaultModel ?? DEFAULT_MODEL
    this.staticModels = config.models ?? []
    this.apiKeyRef = config.apiKeyKey ?? API_KEY_REF
    this.apiKeyEnv = config.apiKeyEnv ?? API_KEY_ENV
    this.catalogTimeoutMs = config.catalogTimeoutMs ?? 10_000
    this.fetchModels = config.fetchModels ?? true
    // 惰性解析 key：boot 不失败；真正调用时若未配置，带诊断显式报错。
  }

  /** 惰性解析 API key：未配置时抛出带「该配置什么」诊断的 LlmError。 */
  private requireApiKey(): string {
    try {
      return this.credentials.get(this.apiKeyRef)
    } catch (error) {
      throw new LlmError(
        'PROVIDER_ERROR',
        `mimo: ${(error as Error).message}（设置面板 → MiMo 配置 API Key，或设 ${this.apiKeyEnv}）`,
      )
    }
  }

  /** best-effort 取 key（目录拉取用；未配置返回 undefined，拉取失败静默退兜底）。 */
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
    return { id: provider, name: 'MiMo' }
  }

  /** 适配器自有的配置声明：设置面板渲染 API Key / Base URL 并判定 configured。 */
  providerConfig(provider: string): ProviderConfigDecl {
    return {
      provider,
      name: '小米 MiMo',
      description:
        '小米 MiMo 开放平台：mimo-v2.6-pro / v2.6-flash，OpenAI 兼容。支持全模态理解、深度思考、函数调用；上下文 1M、单次输出上限 128K。',
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
          hint: `MiMo 开放平台 → API Keys 创建。存于 secrets 文件（${this.apiKeyRef}）${this.apiKeyEnv === undefined ? '' : `，环境变量 ${this.apiKeyEnv} 兜底`}。保存后热生效。`,
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
   * - fetchModels（默认 true）→ 拉取 GET /models 并缓存 5 分钟，滤掉 TTS/ASR
   *   型号；失败静默退回静态兜底；
   * - 未配置 key 时同失败处理（该端点需要鉴权）。
   */
  async listModels(provider: string): Promise<readonly string[]> {
    if (provider !== PROVIDER) return []
    if (this.staticModels.length > 0) return this.staticModels
    if (!this.fetchModels) return FALLBACK_MODELS
    const now = Date.now()
    if (this.catalogCache !== null && now - this.catalogFetchedAt < CATALOG_TTL_MS) {
      return this.catalogCache
    }
    const ids = await fetchModelCatalog(
      this.resolvedBaseUrl(),
      this.optionalApiKey(),
      this.catalogTimeoutMs,
    )
    if (ids === null) return this.catalogCache ?? FALLBACK_MODELS
    this.catalogCache = ids
    this.catalogFetchedAt = now
    return ids
  }

  /** 解析确切模型：目录 advisory，不拦截未列出模型。 */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<ResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    yield* streamChat({
      baseUrl: this.resolvedBaseUrl(),
      apiKey: this.requireApiKey(),
      defaultModel: this.defaultModel,
      request,
    })
  }
}

/** 插件激活：注册凭据来源，构建适配器，注册 provider 路由。 */
export function apply(ctx: Context, config: MimoConfig = {}) {
  const envKey = config.apiKeyEnv ?? API_KEY_ENV
  ctx.credentials.provide(API_KEY_REF, {
    key: config.apiKeyKey ?? 'mimo.apiKey',
    envKey,
  }, {
    ref: `Xiaomi MiMo API key (credentials.config.file → mimo.apiKey, or env ${envKey})`,
  })
  ctx.llm.registerAdapter([PROVIDER], new MimoLlmAdapter(ctx.credentials, config))
}
