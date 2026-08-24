// @diver/backend — 自有传输层共享类型（backend/ 子模块）。
// 避免 backend/index、backend/sse、backend/handlers 之间循环依赖。

import type { ServerResponse } from 'node:http'

export interface WebState {
  agent: any
  agentHandle: any
  busy: boolean
  clients: Set<ServerResponse>
  presencePending: boolean
  toolNames: Map<string, string>
}

export interface WebHandlerDeps {
  ctx: any
  state: WebState
  sseWrite: (res: ServerResponse, event: unknown) => void
  healthInfo: () => Promise<any>
  isModelConfigured: () => Promise<boolean>
  isOpencodeConfigured: () => Promise<boolean>
  ensureAgent: () => Promise<any>
  applyModelChange: (provider?: string, model?: string) => Promise<void>
  catalogModels: () => Promise<Array<{ provider: string; id: string }>>
  providerDecls: () => Promise<Array<Record<string, unknown>>>
  applyProviderConfigs: (providerConfigs: Record<string, Record<string, string>>) => Promise<void>
  port: number
  uiDist: string
}