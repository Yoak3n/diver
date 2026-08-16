// Diver companion — 自有传输层插件。
//
// 提供：静态 UI（生产模式）+ JSON/SSE API。不使用 dsh 的任何交互层
// （apiproxy / client-connection / web UI），只依赖框架服务
// （sessions / agents / credentials / settings / llm / sessionPersistence）。

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize, resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import {
  ensureCompanionAgent,
  readDiverSettings,
  writeDiverSettings,
  textOf,
  SESSION_ID,
  userMessage,
} from './session.ts'
import { getProviderConfig, listProviderConfigs, registerProviderConfig } from './settings-registry.ts'
import { cleanupSubagentSessions } from './memory/summarize.ts'

export const name = 'diver-companion-web'

/** 依赖的框架服务。 */
export const inject = ['sessions', 'agents', 'credentials', 'settings', 'llm', 'sessionPersistence', 'agentDefaultModel', 'userQuestions']

const DEFAULT_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

export function apply(ctx, config) {
  const port = Number(process.env.DIVER_PORT ?? 3620)
  const uiDist = config?.uiDist ?? resolve(process.cwd(), '..', 'dist')

  // 启动兜底：清掉历史遗留的子代理 session（压缩摘要子代理，含全量历史 prompt）
  try {
    const removed = cleanupSubagentSessions()
    if (removed > 0) console.log(`[diver] 已清理 ${removed} 个遗留子代理会话`)
  } catch (err) {
    console.warn(`[diver] 清理子代理会话失败: ${err?.message ?? err}`)
  }

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

  const state = {
    agent: null,
    agentHandle: null,
    busy: false,
    clients: new Set<import('node:http').ServerResponse>(),
    presencePending: false,
    toolNames: new Map(), // callId -> name
    pendingQuestions: new Map(), // requestId -> { resolve, reject, timer }
  }

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

  async function isModelConfigured() {
    try {
      const resolved = await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))
      if (resolved) return true
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
      const sec = ctx.settings.get('llm-deepseek')
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

  // ───────────────────────── SSE ─────────────────────────

  function sseWrite(res, event) {
    if (res.writableEnded || res.destroyed) return
    res.write(`event: event\ndata: ${JSON.stringify(event)}\n\n`)
  }

  function broadcast(event) {
    for (const client of [...state.clients]) sseWrite(client, event)
  }

  // ───────────────────────── 会话事件 → SSE ─────────────────────────

  ctx.on('session/event', (session, ev) => {
    if (String(session.id) !== SESSION_ID) return
    const time = Number(ev.time) || Date.now()
    switch (ev.type) {
      case 'user/message': {
        // 过滤框架的运行时上下文快照（source.kind === 'plugin'），只透传真实用户消息
        if (ev.data.source?.kind !== 'user') break
        const text = textOf(ev.data.content)
        if (text.startsWith('[presence]')) {
          state.presencePending = true
          broadcast({
            type: 'message', kind: 'system', sessionId: String(session.id),
            messageId: ev.data.id, content: text.replace(/^\[presence\]\s*/, '').trim(),
            origin: 'presence', time,
          })
        } else {
          broadcast({
            type: 'message', kind: 'user', sessionId: String(session.id),
            messageId: ev.data.id, content: text, origin: 'user', time,
          })
        }
        break
      }
      case 'assistant/chunk': {
        const chunk = ev.data.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          // 占位消息 id 按 step 区分（同一 turn 内多步工具调用不冲突）
          broadcast({ type: 'chunk', messageId: `turn-${ev.data.turn}-${ev.data.step}`, delta: chunk.text })
        }
        break
      }
      case 'assistant/message': {
        const text = textOf(ev.data.message.content)
        const origin = state.presencePending ? 'presence' : 'assistant'
        state.presencePending = false
        broadcast({
          type: 'message', kind: 'assistant', sessionId: String(session.id),
          messageId: ev.data.message.id, turnMessageId: `turn-${ev.data.turn}-${ev.data.step}`,
          content: text, origin, time,
        })
        break
      }
      case 'tool/call': {
        state.toolNames.set(String(ev.data.callId), ev.data.name)
        broadcast({ type: 'tool', name: ev.data.name, status: 'call' })
        break
      }
      case 'tool/result': {
        const callId = ev.data.callId !== undefined ? String(ev.data.callId) : undefined
        const name = (callId && state.toolNames.get(callId)) || state.toolNames.values().next().value || 'tool'
        if (callId) state.toolNames.delete(callId)
        broadcast({ type: 'tool', name, status: 'result' })
        break
      }
      case 'turn/start': {
        broadcast({ type: 'turn', state: 'start' })
        break
      }
      case 'turn/end': {
        broadcast({ type: 'turn', state: 'end', reason: ev.data.reason?.kind })
        break
      }
      default:
        break
    }
  })

  ctx.on('agent/error', ({ agent, turn, step, error }) => {
    if (!agent || String(agent.id) !== SESSION_ID) return
    const message = String(error?.message ?? error)
    console.error(`[diver] agent 错误 (turn=${turn}, step=${step}): ${message}`)
    broadcast({ type: 'error', message })
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (!agent || String(agent.id) !== SESSION_ID) return
    state.busy = status === 'running'
    broadcast({ type: 'busy', value: state.busy })
  })

  // ───────────────────────── HTTP 处理 ─────────────────────────

  const cors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  const sendJson = (res, code, body) => {
    cors(res)
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  async function readBody(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (!raw) return {}
    try {
      return JSON.parse(raw)
    } catch {
      return {}
    }
  }

  // 静态 UI（生产模式；dev 由 Vite 直接服务页面）
  async function serveStatic(req, res, pathname) {
    const uiRoot = resolve(uiDist)
    let filePath = normalize(join(uiRoot, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)))
    if (!filePath.startsWith(uiRoot)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    try {
      const info = await stat(filePath)
      if (info.isDirectory()) filePath = join(filePath, 'index.html')
      const body = await readFile(filePath)
      cors(res)
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      cors(res)
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const pathname = url.pathname

    if (req.method === 'OPTIONS') {
      cors(res)
      res.writeHead(204)
      res.end()
      return
    }

    try {
      // /api/stream —— SSE 事件流
      if (pathname === '/api/stream' && req.method === 'GET') {
        cors(res)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write('retry: 3000\n\n')
        state.clients.add(res)
        const h = await healthInfo()
        sseWrite(res, { type: 'hello', ...h })
        // 已有待答问题补发给新客户端（刷新后仍可回答）
        for (const [requestId, pending] of state.pendingQuestions) {
          const item = pending.request
          if (item) sseWrite(res, { type: 'question', requestId, questions: item.questions })
        }
        req.on('close', () => {
          state.clients.delete(res)
          // 无任何客户端在线时，挂起的问题无法回答 → 取消，避免 agent 永久阻塞
          if (state.clients.size === 0 && state.pendingQuestions.size > 0) {
            for (const [requestId, p] of state.pendingQuestions) {
              state.pendingQuestions.delete(requestId)
              p.reject(new Error('ask_user_question 已取消（界面已离线）'))
            }
          }
        })
        return
      }

      // /api/health
      if (pathname === '/api/health' && req.method === 'GET') {
        sendJson(res, 200, await healthInfo())
        return
      }

      // /api/chat —— 发送一条用户消息
      if (pathname === '/api/chat' && req.method === 'POST') {
        const body = await readBody(req)
        const content = String(body.content ?? '').trim()
        if (!content) {
          sendJson(res, 400, { error: '消息不能为空' })
          return
        }
        if (state.busy) {
          sendJson(res, 409, { error: '小潜还在思考中，稍等一下…' })
          return
        }
        if (!(await isModelConfigured())) {
          sendJson(res, 400, { error: '尚未配置 API Key，请先在设置中配置' })
          return
        }
        const agent = await ensureAgent()
        const msg = userMessage(content)
        agent.followup(msg)
        sendJson(res, 200, { sessionId: String(agent.id), messageId: String(msg.id) })
        return
      }

      // /api/questions/answer —— 用户回答 ask_user_question 的问题
      if (pathname === '/api/questions/answer' && req.method === 'POST') {
        const body = await readBody(req)
        const requestId = String(body.requestId ?? '')
        const pending = state.pendingQuestions.get(requestId)
        if (!pending) {
          sendJson(res, 404, { error: '问题不存在或已超时' })
          return
        }
        const answers = Array.isArray(body.answers) ? body.answers : null
        if (!answers) {
          sendJson(res, 400, { error: '缺少 answers' })
          return
        }
        state.pendingQuestions.delete(requestId)
        pending.resolve({ answers })
        sendJson(res, 200, { ok: true })
        return
      }

      // /api/history —— 当前会话消息历史（重启后恢复界面）
      if (pathname === '/api/history' && req.method === 'GET') {
        const messages = []
        let presencePending = false
        try {
          const { events } = await ctx.sessionPersistence.readFrom(SessionId(SESSION_ID), 0)
          for (const ev of events) {
            if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
            const time = Number(ev.time) || Date.now()
            if (ev.type === 'user/message') {
              // 同样过滤运行时上下文快照
              if (ev.data.source?.kind !== 'user') continue
              const text = textOf(ev.data.content)
              if (text.startsWith('[presence]')) {
                presencePending = true
                messages.push({
                  id: ev.data.id, kind: 'system',
                  content: text.replace(/^\[presence\]\s*/, '').trim(),
                  origin: 'presence', time,
                })
              } else {
                messages.push({ id: ev.data.id, kind: 'user', content: text, origin: 'user', time })
              }
            } else if (ev.type === 'assistant/message') {
              messages.push({
                id: ev.data.message.id, kind: 'assistant',
                content: textOf(ev.data.message.content),
                origin: presencePending ? 'presence' : 'assistant', time,
              })
              presencePending = false
            }
          }
        } catch { /* 会话尚不存在 */ }
        sendJson(res, 200, { messages: messages.slice(-200) })
        return
      }

      // /api/settings GET / POST
      if (pathname === '/api/settings') {
        if (req.method === 'GET') {
          const s = readDiverSettings()
          const h = await healthInfo()
          sendJson(res, 200, {
            modelConfigured: h.modelConfigured,
            opencodeConfigured: await isOpencodeConfigured(),
            provider: s.provider ?? 'deepseek-official',
            model: s.model ?? h.model,
            models: await catalogModels(),
            providers: await providerDecls(),
            ttsEnabled: !!s.ttsEnabled,
            ttsVoice: s.ttsVoice ?? '',
            sidecar: { state: 'running', port },
          })
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          // 兼容旧字段（前端已迁移到 providerConfigs，这里保留兜底）
          if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
            await ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), body.apiKey.trim())
          }
          if (typeof body.opencodeApiKey === 'string' && body.opencodeApiKey.trim()) {
            await ctx.credentials.set(credentialRef('OPENCODE_API_KEY'), body.opencodeApiKey.trim())
          }
          // 插件化配置：按各 provider 声明动态写入
          await applyProviderConfigs(body.providerConfigs)

          const patch: Record<string, unknown> = {}
          if (typeof body.provider === 'string' && body.provider) patch.provider = body.provider
          if (typeof body.model === 'string' && body.model) patch.model = body.model
          if (typeof body.ttsEnabled === 'boolean') patch.ttsEnabled = body.ttsEnabled
          if (typeof body.ttsVoice === 'string') patch.ttsVoice = body.ttsVoice
          writeDiverSettings(patch)
          if (patch.model || patch.provider) {
            const s = readDiverSettings()
            await applyModelChange(patch.provider ?? s.provider ?? 'deepseek-official', patch.model ?? s.model)
          }
          const h = await healthInfo()
          sendJson(res, 200, { modelConfigured: h.modelConfigured, provider: h.provider, model: h.model })
          return
        }
      }

      // 静态 UI
      if (req.method === 'GET') {
        await serveStatic(req, res, pathname)
        return
      }

      sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      console.error('[diver] 请求处理失败:', err)
      sendJson(res, 500, { error: String(err?.message ?? err) })
    }
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
