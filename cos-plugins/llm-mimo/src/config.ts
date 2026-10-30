// @diver/llm-mimo — 常量与适配器配置类型。

/** 本适配器服务的 provider 路由 id。 */
export const PROVIDER = 'mimo'

/**
 * 默认 API 端点（小米 MiMo 开放平台，OpenAI 兼容 /v1）。
 * 与内置 MiMo TTS 共用同一 base（`src-tauri/src/config/tts.rs`）。
 */
export const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'

/** 凭据 ref 与 env 兜底（官方文档里的变量名）。 */
export const API_KEY_REF = 'mimo.apiKey'
export const API_KEY_ENV = 'MIMO_API_KEY'

/**
 * 默认模型（request.model 为空时使用）。
 * 与目录首项一致（官方 Models 页把 pro 列在前面，后端 `firstModelOf` 也取
 * `models[0]`）；要省成本在设置面板里改选 flash 即可。
 */
export const DEFAULT_MODEL = 'mimo-v2.6-pro'

/**
 * 输出预算上限（官方 `max_completion_tokens` 范围 [1, 131072]，缺省 131072）。
 * 显式传入更大的值会被上游 400，stream 层钳到这个上限。
 */
export const MAX_COMPLETION_TOKENS = 131_072

/** 适配器配置（cordis.yml 的 config 段）。 */
export interface MimoConfig {
  /** API 端点（默认 https://api.xiaomimimo.com/v1）。 */
  baseUrl?: string
  /** 默认模型（无显式 model 时使用；默认 mimo-v2.6-flash）。 */
  defaultModel?: string
  /** 静态模型目录覆盖（不设置时用内置兜底目录；advisory）。 */
  models?: readonly string[]
  /**
   * 是否实时拉取 GET /models 目录。默认 true：MiMo 迭代快（v2.5 已下线并
   * 自动路由到 v2.6），失效 id 不该长期留在下拉里；拉取失败静默退回静态目录。
   */
  fetchModels?: boolean
  /** 凭据文件点路径（默认 mimo.apiKey）。 */
  apiKeyKey?: string
  /** 环境变量兜底（默认 MIMO_API_KEY）。 */
  apiKeyEnv?: string
  /** 拉取 /models 目录的超时（ms）。 */
  catalogTimeoutMs?: number
}
