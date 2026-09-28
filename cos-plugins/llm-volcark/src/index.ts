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
// 与 @cos/llm-deepseek 同构；wire 翻译与工具序列兜底收敛在 @diver/llm-openai-wire。
//
// 分层：config.ts 常量/配置类型 | catalog.ts 模型目录 | stream.ts SSE 翻译；
// 本文件只做适配器装配与插件激活。
// @module @diver/llm-volcark

import type { Context } from 'cordis'
import {
  LlmAdapter,
  LlmError,
} from '@cos/plugin-api'
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
  PROVIDER,
  type VolcArkConfig,
} from './config'
import { streamChat } from './stream'

export { DEFAULT_BASE_URL, PROVIDER }
export type { VolcArkConfig }

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'llm-volcark'

/** 本插件需要的框架服务：@cos/llm 注册表 + @cos/credentials 凭据层。 */
export const inject = ['llm', 'credentials']

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
    if (!this.fetchModels) return FALLBACK_MODELS
    if (this.catalogCache !== null) return this.catalogCache
    const ids = await fetchModelCatalog(
      this.resolvedBaseUrl(),
      this.optionalApiKey(),
      this.catalogTimeoutMs,
    )
    if (ids === null) return FALLBACK_MODELS
    this.catalogCache = ids
    return ids
  }

  /** 解析确切模型：目录 advisory，不拦截未列出模型（含推理接入点 ep-…）。 */
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
