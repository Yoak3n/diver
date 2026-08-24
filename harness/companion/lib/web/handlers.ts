// Diver companion — HTTP 路由处理（web/ 子模块）。

import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import { readDiverSettings, writeDiverSettings, textOf, SESSION_ID, userMessage } from '../session.ts'
import type { WebHandlerDeps } from './types.ts'

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

function cors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function sendJson(res: ServerResponse, code: number, body: unknown) {
  cors(res)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, uiDist: string) {
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

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WebHandlerDeps,
) {
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
      deps.state.clients.add(res)
      const h = await deps.healthInfo()
      deps.sseWrite(res, { type: 'hello', ...h })
      // 已有待答问题补发给新客户端（刷新后仍可回答）
      for (const [requestId, pending] of deps.state.pendingQuestions) {
        const item = pending.request
        if (item) deps.sseWrite(res, { type: 'question', requestId, questions: item.questions })
      }
      req.on('close', () => {
        deps.state.clients.delete(res)
        // 无任何客户端在线时，挂起的问题无法回答 → 取消，避免 agent 永久阻塞
        if (deps.state.clients.size === 0 && deps.state.pendingQuestions.size > 0) {
          for (const [requestId, p] of deps.state.pendingQuestions) {
            deps.state.pendingQuestions.delete(requestId)
            p.reject(new Error('ask_user_question 已取消（界面已离线）'))
          }
        }
      })
      return
    }

    // /api/health
    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, await deps.healthInfo())
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
      if (deps.state.busy) {
        const agent = await deps.ensureAgent()
        const msg = userMessage(content)
        agent.steer(msg)
        sendJson(res, 200, { sessionId: String(agent.id), messageId: String(msg.id), queued: 'next-step' })
        return
      }
      if (!(await deps.isModelConfigured())) {
        sendJson(res, 400, { error: '尚未配置 API Key，请先在设置中配置' })
        return
      }
      const agent = await deps.ensureAgent()
      const msg = userMessage(content)
      agent.followup(msg)
      sendJson(res, 200, { sessionId: String(agent.id), messageId: String(msg.id), queued: false })
      return
    }

    // /api/questions/answer —— 用户回答 ask_user_question 的问题
    if (pathname === '/api/questions/answer' && req.method === 'POST') {
      const body = await readBody(req)
      const requestId = String(body.requestId ?? '')
      const pending = deps.state.pendingQuestions.get(requestId)
      if (!pending) {
        sendJson(res, 404, { error: '问题不存在或已超时' })
        return
      }
      const answers = Array.isArray(body.answers) ? body.answers : null
      if (!answers) {
        sendJson(res, 400, { error: '缺少 answers' })
        return
      }
      deps.state.pendingQuestions.delete(requestId)
      pending.resolve({ answers })
      sendJson(res, 200, { ok: true })
      return
    }

    // /api/history —— 当前会话消息历史（重启后恢复界面）
    if (pathname === '/api/history' && req.method === 'GET') {
      const messages = []
      let presencePending = false
      try {
        const { events } = await deps.ctx.sessionPersistence.readFrom(SessionId(SESSION_ID), 0)
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
        const h = await deps.healthInfo()
        sendJson(res, 200, {
          modelConfigured: h.modelConfigured,
          opencodeConfigured: await deps.isOpencodeConfigured(),
          provider: s.provider ?? 'deepseek-official',
          model: s.model ?? h.model,
          models: await deps.catalogModels(),
          providers: await deps.providerDecls(),
          ttsEnabled: !!s.ttsEnabled,
          ttsVoice: s.ttsVoice ?? '',
          sidecar: { state: 'running', port: deps.port },
        })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        // 兼容旧字段（前端已迁移到 providerConfigs，这里保留兜底）
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
          await deps.ctx.credentials.set(credentialRef('DEEPSEEK_API_KEY'), body.apiKey.trim())
        }
        if (typeof body.opencodeApiKey === 'string' && body.opencodeApiKey.trim()) {
          await deps.ctx.credentials.set(credentialRef('OPENCODE_API_KEY'), body.opencodeApiKey.trim())
        }
        // 插件化配置：按各 provider 声明动态写入
        await deps.applyProviderConfigs(body.providerConfigs)

        const patch: Record<string, unknown> = {}
        if (typeof body.provider === 'string' && body.provider) patch.provider = body.provider
        if (typeof body.model === 'string' && body.model) patch.model = body.model
        if (typeof body.ttsEnabled === 'boolean') patch.ttsEnabled = body.ttsEnabled
        if (typeof body.ttsVoice === 'string') patch.ttsVoice = body.ttsVoice
        writeDiverSettings(patch)
        if (patch.model || patch.provider) {
          const s = readDiverSettings()
          await deps.applyModelChange(patch.provider ?? s.provider ?? 'deepseek-official', patch.model ?? s.model)
        }
        const h = await deps.healthInfo()
        sendJson(res, 200, { modelConfigured: h.modelConfigured, provider: h.provider, model: h.model })
        return
      }
    }

    // 静态 UI
    if (req.method === 'GET') {
      await serveStatic(req, res, pathname, deps.uiDist)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    console.error('[diver] 请求处理失败:', err)
    sendJson(res, 500, { error: String((err as { message?: unknown } | null)?.message ?? err) })
  }
}
