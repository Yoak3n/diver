// Diver companion — 配置项注册表（一切皆插件：每个 provider 插件声明自己的配置 schema，
// 设置面板据此动态渲染，而不是硬编码字段）。

export type ConfigFieldType = 'password' | 'text' | 'select'

/** 一个配置字段的声明。 */
export interface ConfigFieldDecl {
  /** 字段名：store=credentials 时为凭据引用名；store=settings 时为 diver-settings 键（无 provider 前缀）。 */
  key: string
  label: string
  type: ConfigFieldType
  /** 敏感字段：只暴露 configured 布尔，不回传值。 */
  secret?: boolean
  /** 存储位置：凭据库（credentialRef 语义）或 diver-settings.json。 */
  store: 'credentials' | 'settings'
  /** store=credentials 时的环境变量名（credentialRef）。 */
  credentialRef?: string
  required?: boolean
  placeholder?: string
  hint?: string
  options?: string[]
}

/** 一个 provider 的配置声明。 */
export interface ProviderConfigDecl {
  provider: string
  name: string
  description?: string
  fields: ConfigFieldDecl[]
}

const registry = new Map<string, ProviderConfigDecl>()

/** 插件在 apply 时注册自己的配置声明。 */
export function registerProviderConfig(decl: ProviderConfigDecl): void {
  registry.set(decl.provider, decl)
}

export function listProviderConfigs(): ProviderConfigDecl[] {
  return [...registry.values()]
}

export function getProviderConfig(provider: string): ProviderConfigDecl | undefined {
  return registry.get(provider)
}
