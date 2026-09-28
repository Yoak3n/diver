// @diver/llm-commandcode — 常量与适配器配置类型。

/** 本适配器服务的 provider 路由 id。 */
export const PROVIDER = 'commandcode'

/** 默认 API 端点（Provider API 的 OpenAI 兼容路径）。 */
export const DEFAULT_BASE_URL = 'https://api.commandcode.ai/provider/v1'

/** 凭据 ref 与 env 兜底。 */
export const API_KEY_REF = 'commandcode.apiKey'
export const API_KEY_ENV = 'COMMANDCODE_API_KEY'

/** 适配器配置（cordis.yml 的 config 段）。 */
export interface CommandCodeConfig {
  /** Provider API 端点（默认 https://api.commandcode.ai/provider/v1）。 */
  baseUrl?: string
  /** 默认模型（无显式 model 时使用；默认 deepseek/deepseek-v4.1-flash）。 */
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
