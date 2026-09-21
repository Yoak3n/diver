// @diver/backend — HTTP 路由处理（backend/ 子模块）。

import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionId } from '@cos/types'

import { readDiverSettings, writeDiverSettings, textOf } from './session-helpers.ts'
import { SESSION_ID, userMessage } from './agent.ts'
import type { WebHandlerDeps } from './types.ts'

const MIME: Record<string, string> = {
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
      req.on('close', () => {
        deps.state.clients.delete(res)
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
        // 区分"已注册但缺凭据"与"未注册/未启用"，给出不同提示。
        const s = readDiverSettings()
        const provider = typeof s.provider === 'string' && s.provider
          ? s.provider
          : (deps.ctx.llm.listProviders()[0]?.id ?? '')
        const registered = provider !== '' && deps.ctx.llm.listProviders().some((p) => p.id === provider)
        sendJson(res, 400, {
          error: registered ? '尚未配置 API Key，请先在设置中配置' : '当前模型提供商未注册或未启用，请在设置中重新选择',
        })
        return
      }
      const agent = await deps.ensureAgent()
      const msg = userMessage(content)
      agent.followup(msg)
      sendJson(res, 200, { sessionId: String(agent.id), messageId: String(msg.id), queued: false })
      return
    }

    // /api/shutdown —— 优雅退出（仅限本应用：必须携带 DIVER_SHUTDOWN_TOKEN）。
    // Tauri 壳退出时调用：触发 Node 侧 settle() 完整 dispose agent 树后 exit(0)，
    // 避免强杀导致孤儿进程/未落盘的会话状态。令牌不匹配直接 403，静默返回。
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      const body = await readBody(req)
      const expected = process.env.DIVER_SHUTDOWN_TOKEN ?? ''
      if (expected === '' || body.token !== expected) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      sendJson(res, 200, { ok: true })
      // 延迟一瞬再退出：先把 200 响应 flush 给调用方，随后走 signal 路径
      // 触发 companion 的 settle()（与 Ctrl+C / 任务结束一致，agent 树完整 dispose）。
      setTimeout(() => {
        process.kill(process.pid, 'SIGTERM')
      }, 50)
      return
    }

    // /api/history —— 当前会话消息历史（重启后恢复界面）
    if (pathname === '/api/history' && req.method === 'GET') {
      const messages: Array<Record<string, unknown>> = []
      let presencePending = false
      try {
        const events = deps.ctx.sessionPersistence.prepare(SessionId(SESSION_ID)) ?? []
        for (const ev of events) {
          if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
          const time = Number(ev.time) || Date.now()
          if (ev.type === 'user/message') {
            // 同样过滤运行时上下文快照（真实用户消息 source.kind === 'human'）
            if (ev.data.source?.kind !== 'human') continue
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
            // 纯工具调用步骤（无文本）不进入历史，避免前端渲染空气泡
            const text = textOf(ev.data.message.content)
            if (text === '') {
              presencePending = false
              continue
            }
            messages.push({
              id: ev.data.message.id, kind: 'assistant',
              content: text,
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
        const h = await deps.healthInfo()
        sendJson(res, 200, {
          modelConfigured: h.modelConfigured,
          // provider/model 与 harness 注册表对齐（持久化选择失效时钳制到当前适配器）
          provider: h.provider,
          model: h.model,
          models: await deps.catalogModels(),
          providers: await deps.providerDecls(),
          ttsEnabled: !!readDiverSettings().ttsEnabled,
          ttsVoice: (readDiverSettings().ttsVoice as string) ?? '',
          sidecar: { state: 'running', port: deps.port },
        })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
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
          const provider = (typeof patch.provider === 'string' && patch.provider)
            ? patch.provider
            : (typeof s.provider === 'string' && s.provider)
              ? s.provider
              : (deps.ctx.llm.listProviders()[0]?.id ?? '')
          const model = (typeof patch.model === 'string' && patch.model)
            ? patch.model
            : (typeof s.model === 'string' ? s.model : undefined)
          await deps.applyModelChange(provider, model)
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