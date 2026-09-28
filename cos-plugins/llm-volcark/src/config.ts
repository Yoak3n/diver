// @diver/llm-volcark — 常量与适配器配置类型。

/** 本适配器服务的 provider 路由 id。 */
export const PROVIDER = 'volcark'

/** 默认 API 端点（方舟 OpenAI 兼容路径，含 plan 段）。 */
export const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/plan/v3'

/** 凭据 ref 与 env 兜底。 */
export const API_KEY_REF = 'volcark.apiKey'
export const API_KEY_ENV = 'ARK_API_KEY'

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
