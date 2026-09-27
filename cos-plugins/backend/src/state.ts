// @diver/backend — 传输层共享状态（WebState）与工厂。
// 与 types.ts（类型枢纽）分离，便于各子模块独立测试。

import type { ServerResponse } from 'node:http'
import type { Agent, AgentHandle } from '@cos/plugin-api'
import type { PluginInfo } from './plugins.ts'

/** HTTP/SSE 传输层共享状态。 */
export interface WebState {
  /** 当前陪伴 agent（单例会话，惰性创建/resume）。 */
  agent: Agent | null
  agentHandle: AgentHandle | null
  busy: boolean
  clients: Set<ServerResponse>
  presencePending: boolean
  /** P2-3 群聊归属：群/peer 输入后首条助手回复标记 group（合并流只收群相关流量）。 */
  /** 群聊归属挂起（群输入后的首条有正文回复挂 group 标）；携带归属群 id/名。 */
  groupPending: { id: string; name: string } | null
  toolNames: Map<string, string>
  /** 最近一次插件列表缓存（plugin API 变更时广播）。 */
  plugins: PluginInfo[]
}

export function createWebState(): WebState {
  return {
    agent: null,
    agentHandle: null,
    busy: false,
    clients: new Set(),
    presencePending: false,
    groupPending: null,
    toolNames: new Map(),
    plugins: [],
  }
}
