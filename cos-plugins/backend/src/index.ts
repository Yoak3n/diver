// @diver/backend — 后端连接服务入口（backend/ 子模块，第三方插件）。纯装配层。
//
// 职责分配（模块化，避免单一 apply() 耦合过多功能）：
// - index.ts    ：装配 —— 状态、事件接线、依赖注入、server 生命周期
// - agent.ts    ：陪伴 agent 生命周期（单例会话创建/resume、模型切换释放）
// - providers.ts：模型 provider 配置子系统（适配 harness：注册表/凭据/适配器声明）
// - health.ts   ：健康信息组装
// - sse.ts      ：SSE 写入与 harness 事件 → SSE 映射
// - handlers.ts ：HTTP 路由分发（含静态 UI）
// - server.ts   ：HTTP server 创建/监听/释放（thin transport）
// - state.ts    ：传输层共享状态
// - types.ts    ：共享类型，避免循环依赖
//
// 定位：连接后端的服务 —— 外层程序（Tauri UI）经此 HTTP/SSE 服务驱动陪伴
// agent、读取健康/设置/历史；并非"web 服务"本身，故命名为 backend。
//
// 对新版 harness 框架的适配（provider 配置"一切皆插件"）：
// - provider 目录/显示名来自 ctx.llm.listProviders()（适配器注册的路由），
//   不再硬编码 deepseek-official / opencode-go；
// - 模型目录来自 ctx.llm.listModels(provider)（适配器自行声明，advisory），
//   不再硬编码 DEFAULT_MODELS；
// - 配置字段 schema 由各适配器插件经 LlmAdapter.providerConfig() 声明，
//   ctx.llm.listProviderConfigs() 汇总，设置面板据此动态渲染；
// - 凭据判定经 ctx.credentials（适配器已 provide），写入框架配置的
//   credentials.config.file 对应的 secrets 文件（见 ./secrets.ts）。
//
// 接入方式（见 harness/docs/plugins.md）：
//   pnpm add file:../cos-plugins/backend
//   经 @diver/bundle-companion 组装挂载（cordis.patch.yml insert）

import { resolve } from 'node:path'
import type { Context } from 'cordis'
import type {} from '@cos/plugin-api'

import { applyModelChange, ensureAgent } from './agent.ts'
import { healthInfo } from './health.ts'
import { createIdleGate } from './idle-gate.ts'
import { idleGateConfigOf, readPetInteractionSettings } from './interaction.ts'
import { applyProviderConfigs, catalogModels, isConfigured, persistedProvider, providerDecls } from './providers.ts'
import { startPresenceScheduler } from './presence.ts'
import { mountServer } from './server.ts'
import { attachEventListeners, createBroadcast, sseWrite } from './sse.ts'
import { createWebState } from './state.ts'
import type { WebHandlerDeps } from './types.ts'

export const name = 'backend'

/** 依赖的框架服务（按新 harness 的服务清单声明）。 */
export const inject = ['agents', 'agentLoop', 'llm', 'credentials', 'sessionPersistence']

export function apply(ctx: Context, config: { uiDist?: string }) {
  const port = Number(process.env.DIVER_PORT ?? 53620)
  const uiDist = config?.uiDist ?? process.env.DIVER_UI_DIST ?? resolve(process.cwd(), '..', 'dist')

  const state = createWebState()
  // 闲时门控：互动事件与 presence 共用（配置热读 diver-settings.petInteraction）
  state.idleGate = createIdleGate(
    () => state.busy,
    () => idleGateConfigOf(readPetInteractionSettings()),
  )
  const broadcast = createBroadcast(state)
  attachEventListeners(ctx, state, broadcast)

  const deps: WebHandlerDeps = {
    ctx,
    state,
    sseWrite,
    healthInfo: () => healthInfo(ctx, state),
    // 聊天守卫按"持久化/选择的 provider"判定（未注册或无 key → 拒绝）。
    isModelConfigured: () => isConfigured(ctx, persistedProvider(ctx)),
    ensureAgent: () => ensureAgent(ctx, state),
    applyModelChange: (provider, model) => applyModelChange(ctx, state, provider, model),
    catalogModels: () => catalogModels(ctx),
    providerDecls: () => providerDecls(ctx),
    applyProviderConfigs: (providerConfigs) => applyProviderConfigs(ctx, providerConfigs),
    port,
    uiDist,
  }

  mountServer(ctx, deps)

  // presence 日程调度：到点主动问候 + 原生通知（配置存 $COS_HOME/presence-schedule.json）。
  // 与互动事件共用 idleGate，避免正忙/刚聊过时双源抢话。
  startPresenceScheduler(ctx, state, {
    isModelConfigured: () => isConfigured(ctx, persistedProvider(ctx)),
    ensureAgent: () => ensureAgent(ctx, state),
  })
}