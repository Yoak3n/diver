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
import type { PluginConfigDecl } from '@cos/plugin-api'

import { cosHome } from './session.ts'
import { MemoryStore } from './store-rpc.ts'
import { startDigestScheduler } from './digest-scheduler.ts'
import { startCuriosity } from './curiosity-runtime.ts'
import { exploreJobs } from './explore.ts'
import { createLlmSummarizer } from './explore-land.ts'
import { registerRelationCard } from './relation-card.ts'
import { registerTopicTools } from './tools-topics.ts'
import { registerEntityTool } from './tools-entity.ts'
import { registerIdentityTools } from './tools-identity.ts'
import { registerTurnScope } from './turn-scope.ts'

export const name = 'memory'

export const inject = ['sessions', 'llm', 'tools', 'systemPrompt', 'subagents']

export interface MemoryConfig {
  /** 消化 worker 最小间隔（ms）。 */
  digestIntervalMs?: number
  /** 好奇心总开关：关掉后不取词、不扫笔记、不订阅。 */
  curiosityEnabled?: boolean
  chatScan?: boolean
  notesScan?: boolean
  /** 每轮扫描最多新增条目数。 */
  scanLimit?: number
  /** 固定源订阅（MiMo/DeepSeek 更新页 + GitHub releases）。 */
  subscriptions?: boolean
  /** 额外 GitHub 仓库（逗号/换行分隔 owner/repo）。 */
  extraRepos?: string
  /** 探索结果是否用当前模型提炼成一句话 + 要点。 */
  llmSummary?: boolean
  /** 每两天主动汇报一次小发现。 */
  reportEnabled?: boolean
  reportEveryDays?: number
  reportMinItems?: number
}

export const configDecl: PluginConfigDecl = {
  title: '记忆与好奇心',
  fields: [
    {
      key: 'digestIntervalMs',
      label: '消化间隔（ms）',
      type: 'number',
      section: '记忆',
      default: 600000,
      description: '会话末 digest 的最小间隔；0 用默认值',
    },
    {
      key: 'curiosityEnabled',
      label: '启用好奇心清单',
      type: 'boolean',
      section: '好奇心',
      default: true,
      description: '从群聊词、笔记、实体、订阅里攒待探索条目',
    },
    {
      key: 'chatScan',
      label: '从群聊取词',
      type: 'boolean',
      section: '好奇心',
      default: true,
      description: '只存词与群号，不存原句；不扫陌生人私聊',
    },
    {
      key: 'notesScan',
      label: '从笔记取词',
      type: 'boolean',
      section: '好奇心',
      default: true,
      description: '只扫 owner 笔记，不碰 private-*/group-*',
    },
    {
      key: 'subscriptions',
      label: '订阅固定源',
      type: 'boolean',
      section: '好奇心',
      default: true,
      description: 'MiMo/DeepSeek 更新页 + 自动识别的 GitHub release',
    },
    {
      key: 'extraRepos',
      label: '额外仓库',
      type: 'text',
      section: '好奇心',
      description: '逗号分隔的 owner/repo；留空 = 只自动识别',
    },
    {
      key: 'scanLimit',
      label: '每轮新增上限',
      type: 'number',
      section: '好奇心',
      default: 20,
    },
    {
      key: 'llmSummary',
      label: 'LLM 提炼探索结果',
      type: 'boolean',
      section: '落地与汇报',
      default: true,
      description: '1 句结论 + ≤3 条要点；失败自动退回摘录',
    },
    {
      key: 'reportEnabled',
      label: '主动汇报小发现',
      type: 'boolean',
      section: '落地与汇报',
      default: true,
    },
    {
      key: 'reportEveryDays',
      label: '汇报最小间隔（天）',
      type: 'number',
      section: '落地与汇报',
      default: 2,
    },
    {
      key: 'reportMinItems',
      label: '最少攒几条',
      type: 'number',
      section: '落地与汇报',
      default: 2,
    },
  ],
}

export function apply(ctx: Context, config: MemoryConfig = {}) {
  const store = new MemoryStore(join(cosHome(), 'memory'))

  startDigestScheduler(ctx, store, config?.digestIntervalMs)
  startCuriosity(ctx, store, config)
  // 探索结果提炼：默认跟随当前模型；关闭时 job 内部退回摘录首句。
  exploreJobs.setSummarizer(config?.llmSummary === false ? null : createLlmSummarizer(ctx))
  registerTurnScope(ctx)
  registerRelationCard(ctx, store)
  registerTopicTools(ctx, store)
  registerEntityTool(ctx, store)
  registerIdentityTools(ctx, store)

  ctx.effect(() => () => {
    if (store.dirty) store.save()
  }, 'memory:flush')
  ctx.effect(() => () => {
    exploreJobs.setSummarizer(null)
  }, 'memory:summarizer')

  console.log('[memory] 关系层记忆插件就绪')
}
