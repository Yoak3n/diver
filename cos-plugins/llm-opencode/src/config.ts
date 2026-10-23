// @diver/llm-opencode — 常量。

/** 本适配器服务的 provider 路由 id（沿用 backend 历史注释里的 opencode-go 形态）。 */
export const PROVIDER = 'opencode-go'

/**
 * 聊天端点 base（OpenAI 兼容路径；多数模型走 chat/completions）。
 * Grok 4.7 / GPT-6-Luna 等仅支持 /responses 端点的模型不在本适配范围。
 */
export const DEFAULT_BASE_URL = 'https://opencode.ai/inference/go/openai/v1'

/**
 * 模型目录端点——与聊天 base 不同树（无 /openai 段），不能从 baseUrl 推导，
 * 单独硬编码。见 https://opencode.ai/docs/go/
 */
export const MODELS_URL = 'https://opencode.ai/inference/go/v1/models'

/** 凭据 ref 与 env 兜底。 */
export const API_KEY_REF = 'opencode-go.apiKey'
export const API_KEY_ENV = 'OPENCODE_GO_API_KEY'

/** 网关建议客户端自带 user-agent（识别真实客户端而非通用 SDK）。 */
export const USER_AGENT = 'diver/0.2.0'

/** 默认模型（request.model 为空时使用）。 */
export const DEFAULT_MODEL = 'glm-5.3'
