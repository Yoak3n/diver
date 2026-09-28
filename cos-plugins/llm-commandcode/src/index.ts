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
// 与 @cos/llm-deepseek 同构，但作为第三方插件放在 cos-plugins/ 下，不进 harness 工作区；
// wire 翻译与工具序列兜底收敛在 @diver/llm-openai-wire。
//
// GOAT 套餐要点（见 https://commandcode.ai/docs/plans/goat）：
//   - $10/月，$14/5 小时 + $35/周 + $70/月 用量上限；
//   - 模型 id 形如 "deepseek/deepseek-v4.1-flash"、"Qwen/Qwen3.8-Max"（带 provider 前缀，
//     必须原样传给 API，不能去掉）；
//   - 流式请求带 stream_options.include_usage 可在末尾收到 usage 块。
//
// 分层：config.ts 常量/配置类型 | catalog.ts 模型目录 | stream.ts SSE 翻译；
// 本文件只做适配器装配与插件激活。
// @module @diver/llm-commandcode

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
  type CommandCodeConfig,
} from './config'
import { streamChat } from './stream'

export { DEFAULT_BASE_URL, PROVIDER }
export type { CommandCodeConfig }

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'llm-commandcode'

/** 本插件需要的框架服务：@cos/llm 注册表 + @cos/credentials 凭据层。 */
export const inject = ['llm', 'credentials']

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
    this.defaultModel = config.defaultModel ?? 'deepseek/deepseek-v4.1-flash'
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
    if (!this.fetchModels) return FALLBACK_MODELS
    if (this.catalogCache !== null) return this.catalogCache
    const ids = await fetchModelCatalog(this.resolvedBaseUrl(), this.catalogTimeoutMs)
    if (ids === null) return FALLBACK_MODELS
    this.catalogCache = ids
    return ids
  }

  /** 解析确切模型：仅校验存在（目录 advisory，不拦截未列出模型）。 */
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
