// @diver/backend — 后端连接服务入口（backend/ 子模块，第三方插件）。
//
// 职责分配：
// - backend/index.ts   ：装配插件、共享状态、agent/health/settings 业务函数、HTTP server 生命周期
// - backend/sse.ts     ：SSE 写入与 harness 事件 → SSE 映射
// - backend/handlers.ts：HTTP 路由分发（含静态 UI）
// - backend/types.ts   ：共享类型，避免循环依赖
//
// 定位：连接后端的服务 —— 外层程序（Tauri UI）经此 HTTP/SSE 服务驱动陪伴
// agent、读取健康/设置/历史；并非"web 服务"本身，故命名为 backend。
//
// 迁移说明（harness-old → @diver/backend）：
// - agent 创建/resume 改用 ctx.agentLoop.createAgent（见 ./session.ts）
// - 凭据读取用 ctx.credentials.get（新 harness 只读）；写入经 ./secrets.ts 直写 secrets 文件
// - 移除 userQuestions / settings / agentDefaultModel 依赖（新 harness 无这些服务）
//
// 接入方式（见 harness/docs/plugins.md）：
//   pnpm add file:../cos-plugins/backend
//   经 @diver/bundle-companion 组装挂载（cordis.patch.yml insert）

import { createServer } from 'node:http'
import { resolve } from 'node:path'
import type { Context } from 'cordis'

import { ensureCompanionAgent, SESSION_ID } from './session'
import { readDiverSettings, writeDiverSettings } from './session-helpers'
import { getProviderConfig, listProviderConfigs, registerProviderConfig } from './settings-registry'
import { writeSecret } from './secrets'
import { attachEventListeners, createBroadcast, sseWrite } from './sse'
import { handleRequest } from './handlers'
import type { WebState } from './types'

export const name = 'backend'

/** 依赖的框架服务。 */
export const inject = ['sessions', 'agents', 'agentLoop', 'credentials', 'llm', 'sessionPersistence']

const DEFAULT_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

export function apply(ctx: Context, config: { uiDist?: string }) {
  const port = Number(process.env.DIVER_PORT ?? 3620)
  const uiDist = config?.uiDist ?? process.env.DIVER_UI_DIST ?? resolve(process.cwd(), '..', 'dist')

  // 一切皆插件：deepseek 适配器由 harness 提供，其配置声明由本插件注册
  // （设置面板据此渲染 API Key 输入，写入 secrets 文件）。
  registerProviderConfig({
    provider: 'deepseek-official',
    name: 'DeepSeek（官方）',
    description: 'DeepSeek 官方 API（deepseek-v4-flash / deepseek-v4-pro）。',
    fields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        secret: true,
        store: 'credentials',
        credentialRef: 'deepseek.apiKey',
        required: true,
        placeholder: 'sk-…',
        hint: '存于 secrets 文件（deepseek.apiKey），环境变量兜底',
      },
    ],
  })

  const state: WebState = {
    agent: null,
    agentHandle: null,
    busy: false,
    clients: new Set(),
    presencePending: false,
    toolNames: new Map(),
  }

  const broadcast = createBroadcast(state)

  // ───────────────────────── 会话与 agent ─────────────────────────

  async function ensureAgent() {
    if (state.agent) return state.agent
    const settings = readDiverSettings()
    const { agent, handle } = await ensureCompanionAgent(ctx, settings.model, settings.provider)
    state.agent = agent
    state.agentHandle = handle
    return agent
  }

  /** 模型/提供商切换：释放旧 agent，下次对话按新配置重建（会话记忆保留）。 */
  async function applyModelChange(provider?: string, model?: string) {
    if (!model || !state.agent) return
    if (state.agent.options.provider === provider && state.agent.options.model === model) return
    if (state.agentHandle) {
      try {
        await state.agentHandle.dispose()
      } catch (err) {
        console.error('[diver] 释放旧 agent 失败:', err)
      }
    }
    state.agent = null
    state.agentHandle = null
  }

  // ───────────────────────── 状态查询 ─────────────────────────

  function currentProvider() {
    try {
      const settings = readDiverSettings()
      return settings.provider ?? 'deepseek-official'
    } catch { /* 忽略 */ }
    return 'deepseek-official'
  }

  async function isModelConfigured() {
    // 按当前激活 provider 判定：opencode-go 网关支持无 key 裸请求（key 可选），
    // mock 本地适配器无需 key；只有 DeepSeek 官方 provider 必须校验 API Key。
    const provider = currentProvider()
    if (provider !== 'deepseek-official') return true
    try {
      const resolved = ctx.credentials.get('deepseek.apiKey')
      if (resolved) return true
    } catch { /* 忽略 */ }
    return !!process.env.DEEPSEEK_API_KEY
  }

  async function isOpencodeConfigured() {
    try {
      const resolved = ctx.credentials.get('opencode.apiKey')
      if (resolved) return true
    } catch { /* 忽略 */ }
    return !!process.env.OPENCODE_API_KEY
  }

  function currentDefaultModel() {
    return DEFAULT_MODELS[0]
  }

  /** 模型目录（合并各 provider）。 */
  async function catalogModels() {
    const models: Array<{ provider: string; id: string }> = []
    // deepseek（官方适配器目录）
    try {
      const ds = await ctx.llm.listModels('deepseek-official')
      const list = ds.length > 0 ? ds : DEFAULT_MODELS
      for (const id of list) models.push({ provider: 'deepseek-official', id })
    } catch { /* 忽略 */ }
    // opencode-go（listModels 动态拉取，失败静默）
    try {
      const list = await ctx.llm.listModels('opencode-go')
      for (const m of list) models.push({ provider: 'opencode-go', id: m })
    } catch { /* 忽略 */ }
    return models
  }

  async function healthInfo() {
    const settings = readDiverSettings()
    const provider = settings.provider ?? 'deepseek-official'
    const model = settings.model ?? currentDefaultModel()
    return {
      ok: true,
      persona: '小潜',
      provider,
      model,
      modelConfigured: await isModelConfigured(),
      memoryPort: Number(process.env.DIVER_MEMORY_PORT ?? 0),
      sessionId: state.agent ? String(state.agent.id) : null,
      busy: state.busy,
    }
  }

  // ───────────────────────── 配置注册表 → 设置面板 ─────────────────────────

  /** 解析一个字段的当前状态（secret 字段只返回 configured 布尔）。 */
  async function fieldStatus(field: { store?: string; credentialRef?: string; key: string }) {
    if (field.store === 'credentials') {
      try {
        const resolved = ctx.credentials.get(field.credentialRef ?? field.key)
        if (resolved) return { configured: true }
      } catch { /* 忽略 */ }
      return { configured: !!process.env[field.credentialRef ?? field.key] }
    }
    // store === 'settings'
    const s = readDiverSettings()
    return { configured: typeof s[field.key] === 'string' && s[field.key].trim().length > 0 }
  }

  /** 组装 providers 声明 + 状态（供 UI 动态渲染配置面板）。 */
  async function providerDecls() {
    const out: Array<Record<string, unknown>> = []
    for (const decl of listProviderConfigs()) {
      const fields: Array<Record<string, unknown>> = []
      for (const f of decl.fields) {
        const status = await fieldStatus(f)
        fields.push({ ...f, ...status })
      }
      out.push({ provider: decl.provider, name: decl.name, description: decl.description, fields })
    }
    return out
  }

  /** 按声明动态写入 provider 配置（credentials → secrets 文件；settings → diver-settings）。 */
  async function applyProviderConfigs(providerConfigs: Record<string, Record<string, string>>) {
    if (!providerConfigs || typeof providerConfigs !== 'object') return
    const patch: Record<string, unknown> = {}
    for (const [provider, values] of Object.entries(providerConfigs)) {
      const decl = getProviderConfig(provider)
      if (!decl || !values || typeof values !== 'object') continue
      for (const field of decl.fields) {
        const raw = values[field.key]
        if (typeof raw !== 'string' || !raw.trim()) continue
        const value = raw.trim()
        if (field.store === 'credentials') {
          writeSecret(field.credentialRef ?? field.key, value)
        } else {
          // settings 字段带 provider 前缀落盘（如 opencode-go.baseUrl）
          patch[`${provider}.${field.key}`] = value
        }
      }
    }
    if (Object.keys(patch).length > 0) writeDiverSettings(patch)
  }

  // ───────────────────────── SSE 与 HTTP 装配 ─────────────────────────

  attachEventListeners(ctx, state, broadcast)

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    void handleRequest(req, res, url, {
      ctx,
      state,
      sseWrite,
      healthInfo,
      isModelConfigured,
      isOpencodeConfigured,
      ensureAgent,
      applyModelChange,
      catalogModels,
      providerDecls,
      applyProviderConfigs,
      port,
      uiDist,
    })
  })

  server.on('error', (err) => {
    console.error(`[diver] HTTP 服务错误: ${err.message}`)
  })

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address()
    const actual = typeof addr === 'object' && addr ? addr.port : port
    console.log(`[diver] companion backend listening on 127.0.0.1:${actual}`)
    console.log(`DIVER_READY http://127.0.0.1:${actual}`)
  })

  ctx.effect(() => () => {
    for (const client of [...state.clients]) client.end()
    state.clients.clear()
    server.close()
  }, 'backend:server')
}