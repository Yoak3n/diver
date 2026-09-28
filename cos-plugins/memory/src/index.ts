// @diver/memory — 记忆插件（第三方插件，独立于 harness 工作区部署）。
//
// 接线（2026-08 简化 + subagent 化）：
// - 写路径：不做逐轮 LLM 提取；记忆来源为
//   ① agent 主动 remember 工具（对话中自觉沉淀）
//   ② 记忆消化 subagent（见 ./digest.ts）：会话末 digest / 压缩摘要内化
//     都委托给 harness 核心的 ctx.subagents，worker 用工具直写记忆，
//     不再走"单次 LLM 调用 + parseJson 提取 JSON diff"
// - 消化调度（见 ./digest-scheduler.ts）：turn/end 与 compaction/summary
//   一有材料就派发消化 worker，与主会话并行不悖；同时至多一个 worker。
// - 读路径：身份卡片 + Mode B 近期摘要经 systemPrompt.section 常驻注入
//   （见 ./relation-card.ts）；工具供 agent 自主管理记忆：
//   话题 remember/recall/inventory/demote（./tools-topics.ts）、
//   实体图谱 entity（./tools-entity.ts）、身份 set_name/identity（./tools-identity.ts）。
//
// 存储：经 ./store-rpc.ts 直连 Rust SQLite 后端（DIVER_MEMORY_PORT HTTP RPC）。
//
// 接入方式（见 harness/docs/plugins.md）：
//   pnpm add file:../cos-plugins/memory
//   cordis.patch.yml: - insert: [{ id: memory, name: '@diver/memory', config: {...} }]

import { join } from 'node:path'
import type { Context } from 'cordis'
// Load Cordis Context service-key declarations (ctx.tools / llm / subagents …).
import type {} from '@cos/plugin-api'

import { cosHome } from './session.ts'
import { MemoryStore } from './store-rpc.ts'
import { startDigestScheduler } from './digest-scheduler.ts'
import { registerRelationCard } from './relation-card.ts'
import { registerTopicTools } from './tools-topics.ts'
import { registerEntityTool } from './tools-entity.ts'
import { registerIdentityTools } from './tools-identity.ts'

export const name = 'memory'

export const inject = ['sessions', 'llm', 'tools', 'systemPrompt', 'subagents']

export function apply(ctx: Context, config: { digestIntervalMs?: number }) {
  const store = new MemoryStore(join(cosHome(), 'memory'))

  startDigestScheduler(ctx, store, config?.digestIntervalMs)
  registerRelationCard(ctx, store)
  registerTopicTools(ctx, store)
  registerEntityTool(ctx, store)
  registerIdentityTools(ctx, store)

  ctx.effect(() => () => {
    if (store.dirty) store.save()
  }, 'memory:flush')

  console.log('[memory] 关系层记忆插件就绪')
}
