// @diver/llm-opencode — OpenCode Go 网关适配器（@cos/llm 注册表插件）。
//
// 适配 OpenCode Go 的 OpenAI 兼容端点（https://opencode.ai/docs/go/）：
//   - 聊天 POST https://opencode.ai/inference/go/openai/v1/chat/completions
//   - 目录 GET  https://opencode.ai/inference/go/v1/models（与聊天 base 不同树）
//   - 网关硬要求每请求带稳定会话头 x-opencode-session（缺这 400 MissingSessionID），
//     取 GenerateOptions.sessionId——每会话稳定、跨轮次不变，正好做路由亲和 +
//     prompt 缓存命中；llm-custom 走不通（无扩展点），故有本插件。
//
// 本插件在 @cos/llm 注册表注册 provider 路由 "opencode-go"：
//   - providerInfo()   → 显示名 "OpenCode Go"
//   - providerConfig() → 设置面板配置声明（apiKey 凭据字段 + baseUrl 可选覆盖）
//   - listModels()     → 实时拉取目录并缓存，失败静默退回静态兜底（advisory）
//   - stream()         → SSE → block-protocol StreamChunk（stream.ts）
//
// 分层：config.ts 常量 | catalog.ts 模型目录 | stream.ts SSE 翻译；
// 本文件只做适配器装配与插件激活。
// @module @diver/llm-opencode

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
  MODELS_URL,
  PROVIDER,
} from './config'
import { streamChat } from './stream'

export { DEFAULT_BASE_URL, PROVIDER }

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'llm-opencode'

/** 本插件需要的框架服务：@cos/llm 注册表 + @cos/credentials 凭据层。 */
export const inject = ['llm', 'credentials']

/** 目录拉取超时与缓存时长（目录 advisory，无需更勤）。 */
const CATALOG_TIMEOUT_MS = 10_000
const CATALOG_TTL_MS = 60_000

class OpencodeGoLlmAdapter extends LlmAdapter {
  private readonly credentials: Context['credentials']
  private catalogCache: readonly string[] | null = null
  private catalogFetchedAt = 0

  constructor(credentials: Context['credentials']) {
    super()
    this.credentials = credentials
    // 惰性解析 key：boot 不失败；真正调用时若未配置，带诊断显式报错。
  }

  /** 惰性解析 API key：未配置时抛出带"该配置什么"诊断的 LlmError。 */
  private requireApiKey(): string {
    try {
      return this.credentials.get(API_KEY_REF)
    } catch (error) {
      throw new LlmError(
        'PROVIDER_ERROR',
        `opencode-go: ${(error as Error).message}（设置面板 → OpenCode Go 配置 API Key，或设 ${API_KEY_ENV}）`,
      )
    }
  }

  /** best-effort 取 key（目录拉取用；未配置返回 undefined，端点公开）。 */
  private optionalApiKey(): string | undefined {
    try {
      return this.credentials.get(API_KEY_REF)
    } catch {
      return undefined
    }
  }

  /** 运行时 baseUrl：优先 settings UI 写入的 <provider>.baseUrl（热生效），否则默认。 */
  private resolvedBaseUrl(): string {
    return (this.settingsValue(PROVIDER, 'baseUrl') ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenCode Go' }
  }

  /** 适配器自有的配置声明：设置面板渲染 API Key 字段并判定 configured。 */
  providerConfig(provider: string): ProviderConfigDecl {
    return {
      provider,
      name: 'OpenCode Go',
      description:
        'OpenCode Go 网关的 OpenAI 兼容端点：每请求带 x-opencode-session 会话头（路由亲和 + prompt 缓存）。仅 /responses 端点的模型（grok-4.7 / gpt-6-luna 等）暂不支持。',
      fields: [
        {
          key: 'apiKey',
          label: 'API Key',
          type: 'password',
          secret: true,
          store: 'credentials',
          credentialRef: API_KEY_REF,
          envKey: API_KEY_ENV,
          required: true,
          placeholder: '…',
          hint: `opencode.ai 控制台订阅 Go 后签发。存于 secrets 文件（${API_KEY_REF}），环境变量 ${API_KEY_ENV} 兜底。保存后热生效。`,
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
   * 模型目录（advisory）：实时拉取 /v1/models 并缓存 60s；失败或空目录静默
   * 退回静态兜底（设置面板打开/模型下拉即触发一次，超时 10s 不阻塞交互）。
   */
  async listModels(provider: string): Promise<readonly string[]> {
    if (provider !== PROVIDER) return []
    const now = Date.now()
    if (this.catalogCache !== null && now - this.catalogFetchedAt < CATALOG_TTL_MS) {
      return this.catalogCache
    }
    const ids = await fetchModelCatalog(MODELS_URL, CATALOG_TIMEOUT_MS, this.optionalApiKey())
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
      defaultModel: DEFAULT_MODEL,
      request,
    })
  }
}

/** 插件激活：注册凭据来源，构建适配器，注册 provider 路由。 */
export function apply(ctx: Context) {
  ctx.credentials.provide(API_KEY_REF, { key: API_KEY_REF, envKey: API_KEY_ENV }, {
    ref: `OpenCode Go API key (credentials.config.file → ${API_KEY_REF}, or env ${API_KEY_ENV})`,
  })
  ctx.llm.registerAdapter([PROVIDER], new OpencodeGoLlmAdapter(ctx.credentials))
}
