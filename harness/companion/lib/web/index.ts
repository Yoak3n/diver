// Diver companion — 自有传输层入口（web/ 子模块）。
//
// 职责分配：
// - web/index.ts   ：装配插件、共享状态、agent/health/settings 业务函数、HTTP server 生命周期
// - web/sse.ts     ：SSE 写入与 dsh 事件 → SSE 映射
// - web/handlers.ts：HTTP 路由分发（含静态 UI）
// - web/types.ts   ：共享类型，避免循环依赖

import { createServer } from 'node:http'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import {
  ensureCompanionAgent,
  readDiverSettings,
  writeDiverSettings,
} from '../session.ts'
import { getProviderConfig, listProviderConfigs, registerProviderConfig } from '../settings-registry.ts'
import { attachEventListeners, createBroadcast, sseWrite } from './sse.ts'
import { handleRequest } from './handlers.ts'
import type { WebState } from './types.ts'

export const name = 'diver-companion-web'

/** 依赖的框架服务。 */
export const inject = ['sessions', 'agents', 'credentials', 'settings', 'llm', 'sessionPersistence', 'agentDefaultModel', 'userQuestions']

const DEFAULT_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

export function apply(ctx: Context, config: { uiDist?: string }) {
  const port = Number(process.env.DIVER_PORT ?? 3620)
  const uiDist = config?.uiDist ?? resolve(process.cwd(), '..', 'dist')

  // 一切皆插件：deepseek 适配器由 dsh 框架提供，其配置声明由本 bundle 注册
  // （设置面板据此渲染 API Key 输入，写入 dsh 凭据库）。
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
        credentialRef: 'DEEPSEEK_API_KEY',
        required: true,
        placeholder: 'sk-…',
        hint: '存于凭据库（DEEPSEEK_API_KEY），环境变量兜底',
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
    pendingQuestions: new Map(),
  }

  const broadcast = createBroadcast(state)

  // ───────────────────────── user-questions provider ─────────────────────────
  // 对接 ask_user_question：模型调用 ctx.userQuestions.ask() 时，把问题经 SSE
  // 推给 UI，等待用户通过 POST /api/questions/answer 提交答案后 resolve。
  // （dsh 自带 apiproxy 的 provider 未挂载，这里由自有传输层实现同一 seam。）
  const disposeProvider = ctx.userQuestions.registerProvider({
    ask: (request) =>
      new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID()
        const questions = request.questions.map((q) => ({
          id: q.id,
          question: q.question,
          ...(q.detail !== undefined ? { detail: q.detail } : {}),
          ...(q.header !== undefined ? { header: q.header } : {}),
          ...(q.options !== undefined ? { options: q.options } : {}),
          ...(q.multiSelect !== undefined ? { multiSelect: q.multiSelect } : {}),
        }))
        const timer = setTimeout(() => {
          state.pendingQuestions.delete(requestId)
          reject(new Error('ask_user_question 等待超时（无客户端应答）'))
        }, 5 * 60 * 1000)
        state.pendingQuestions.set(requestId, {
          request: { questions },
          resolve: (answer) => {
            clearTimeout(timer)
            resolve(answer)
          },
          reject: (err) => {
            clearTimeout(timer)
            reject(err)
          },
        })
        broadcast({ type: 'question', requestId, questions })
        request.signal?.addEventListener('abort', () => {
          const p = state.pendingQuestions.get(requestId)
          if (p) {
            state.pendingQuestions.delete(requestId)
            p.reject(new Error('ask_user_question was aborted before the user answered'))
          }
        })
      }),
  })

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
  async function applyModelChange(provider, model) {
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
    // 只有 DeepSeek 官方 provider 必须校验 DEEPSEEK_API_KEY。
    if (currentProvider() === 'opencode-go') return true
    try {
      const resolved = await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))
      if (resolved?.value) return true
    } catch { /* 忽略 */ }
    return !!process.env.DEEPSEEK_API_KEY
  }

  async function isOpencodeConfigured() {
    try {
      const resolved = await ctx.credentials.resolve(credentialRef('OPENCODE_API_KEY'))
      if (resolved?.value) return true
    } catch { /* 忽略 */ }
    return !!process.env.OPENCODE_API_KEY
  }

  function currentDefaultModel() {
    try {
      const sel = ctx.agentDefaultModel?.currentSelection?.()
      if (sel?.model) return sel.model
    } catch { /* 忽略 */ }
    return DEFAULT_MODELS[0]
  }

  /** 模型目录（合并各 provider）。 */
  async function catalogModels() {
    const models = []
    // deepseek（官方适配器目录）
    try {
      const sec = ctx.settings.get('llm-deepseek' as unknown as SettingsNamespace) as
        | { models?: Array<string | { id?: string }> }
        | undefined
      const ds = Array.isArray(sec?.models) && sec.models.length > 0
        ? sec.models.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean)
        : DEFAULT_MODELS
      for (const id of ds) models.push({ provider: 'deepseek-official', id })
    } catch { /* 忽略 */ }
    // opencode-go（listModels 动态拉取，失败静默）
    try {
      const list = await ctx.llm.listModels('opencode-go')
      for (const m of list) models.push({ provider: 'opencode-go', id: m.id })
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
  async function fieldStatus(field) {
    if (field.store === 'credentials') {
      try {
        const resolved = await ctx.credentials.resolve(credentialRef(field.credentialRef ?? field.key))
        if (resolved?.value) return { configured: true }
      } catch { /* 忽略 */ }
      return { configured: !!process.env[field.credentialRef ?? field.key] }
    }
    // store === 'settings'
    const s = readDiverSettings()
    return { configured: typeof s[field.key] === 'string' && s[field.key].trim().length > 0 }
  }

  /** 组装 providers 声明 + 状态（供 UI 动态渲染配置面板）。 */
  async function providerDecls() {
    const out = []
    for (const decl of listProviderConfigs()) {
      const fields = []
      for (const f of decl.fields) {
        const status = await fieldStatus(f)
        fields.push({ ...f, ...status })
      }
      out.push({ provider: decl.provider, name: decl.name, description: decl.description, fields })
    }
    return out
  }

  /** 按声明动态写入 provider 配置（credentials → 凭据库；settings → diver-settings）。 */
  async function applyProviderConfigs(providerConfigs) {
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
          await ctx.credentials.set(credentialRef(field.credentialRef ?? field.key), value)
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
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
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
    console.log(`[diver] companion web listening on 127.0.0.1:${actual}`)
    console.log(`DIVER_READY http://127.0.0.1:${actual}`)
  })

  ctx.on('dispose', () => {
    try {
      disposeProvider()
    } catch { /* 忽略 */ }
    for (const client of [...state.clients]) client.end()
    state.clients.clear()
    // 取消所有挂起问题（agent 不因 UI 下线而永久阻塞）
    for (const [requestId, p] of state.pendingQuestions) {
      state.pendingQuestions.delete(requestId)
      p.reject(new Error('ask_user_question 已取消（服务关闭）'))
    }
    server.close()
  })
}
