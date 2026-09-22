// @diver/backend — 传输层共享类型（backend/ 子模块）。
// 避免 backend/index、backend/handlers、backend/sse 之间循环依赖。

import type { Context } from 'cordis'
import type { ServerResponse } from 'node:http'
import type { AdapterConfigField, Agent, ProviderConfigDecl } from '@cos/plugin-api'

import type { WebState } from './state.ts'

export type { WebState } from './state.ts'
export type { PluginInfo } from './plugins.ts'

/** provider 声明 + 每个字段的当前状态（secret 字段只回传布尔，settings 非 secret 字段附当前值）。 */
export interface ProviderDeclView extends Omit<ProviderConfigDecl, 'fields'> {
  fields: Array<AdapterConfigField & { configured: boolean; value?: string }>
}

export interface WebHandlerDeps {
  ctx: Context
  state: WebState
  sseWrite: (res: ServerResponse, event: unknown) => void
  healthInfo: () => Promise<Record<string, unknown>>
  /** 当前激活 provider（持久化选择或注册表默认）是否已配置模型。 */
  isModelConfigured: () => Promise<boolean>
  ensureAgent: () => Promise<Agent>
  applyModelChange: (provider?: string, model?: string) => Promise<void>
  catalogModels: () => Promise<Array<{ provider: string; id: string }>>
  providerDecls: () => Promise<ProviderDeclView[]>
  applyProviderConfigs: (providerConfigs: Record<string, Record<string, string>>) => Promise<void>
  port: number
  uiDist: string
}