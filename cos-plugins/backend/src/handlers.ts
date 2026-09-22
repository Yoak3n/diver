// @diver/backend — HTTP 路由处理（backend/ 子模块）。

import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SessionId } from '@cos/plugin-api'

import { readDiverSettings, writeDiverSettings, textOf, imagesOf } from './session-helpers.ts'
import { SESSION_ID, userMessage } from './agent.ts'
import {
  handlePetInteractionEvent,
  isInteractionUserMessage,
  readPetInteractionSettings,
} from './interaction.ts'
import { loadSchedule, saveSchedule } from './presence.ts'
import type { WebHandlerDeps } from './types.ts'
import {
  ensureProfile,
  getProfile,
  installProfilePlugin,
  listPlugins,
  nativeStatus,
  setProfile,
  toggleWithBroadcast,
  uninstallProfilePlugin,
  gracefulExitForRestart,
} from './plugins.ts'
import { COMPANION_PROFILE, readActiveProfile, requestRestart } from './paths.ts'

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

function broadcastLocal(deps: WebHandlerDeps, event: unknown) {
  for (const client of [...deps.state.clients]) deps.sseWrite(client, event)
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

    // /api/chat —— 发送一条用户消息（可附带图片）
    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req)
      const content = String(body.content ?? '').trim()
      const rawImages = Array.isArray(body.images) ? body.images : []
      const images: Array<{ mime: string; data: string; name?: string }> = []
      for (const raw of rawImages) {
        if (!raw || typeof raw !== 'object') continue
        const mime = String((raw as { mime?: unknown }).mime ?? '').trim().toLowerCase()
        const data = String((raw as { data?: unknown }).data ?? '').trim()
        const name = String((raw as { name?: unknown }).name ?? '').trim()
        // 只收常见位图；data 为 base64（不含 data: 前缀）
        if (!/^image\/(png|jpe?g|webp|gif)$/.test(mime)) continue
        if (data === '' || data.length > 12_000_000) continue
        images.push({
          mime,
          data: data.replace(/^data:[^,]+,/, ''),
          ...(name !== '' ? { name } : {}),
        })
      }
      if (images.length > 8) images.length = 8
      if (!content && images.length === 0) {
        sendJson(res, 400, { error: '消息不能为空' })
        return
      }
      if (deps.state.busy) {
        const agent = await deps.ensureAgent()
        const msg = userMessage(content || '（图片）', images)
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
      const msg = userMessage(content || '（图片）', images)
      agent.followup(msg)
      sendJson(res, 200, { sessionId: String(agent.id), messageId: String(msg.id), queued: false })
      return
    }

    // /api/event —— 桌宠互动事件（闲时才注入 agent；见 interaction.ts / docs/pet-interaction-events.md）
    if (pathname === '/api/event' && req.method === 'POST') {
      const body = await readBody(req)
      if (!deps.state.idleGate) {
        sendJson(res, 200, { accepted: false, reason: 'disabled' })
        return
      }
      const result = await handlePetInteractionEvent(body, {
        state: deps.state,
        gate: deps.state.idleGate,
        ensureAgent: deps.ensureAgent,
        isModelConfigured: deps.isModelConfigured,
      })
      sendJson(res, 200, result)
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
      // 逐步收集 thinking-delta，挂到同 step 的 assistant 消息上
      const thinkingByStep = new Map<string, string>()
      // step → 消息下标，便于 tool/result 回填工具结果
      const msgIndexByStep = new Map<string, number>()
      let presencePending = false
      try {
        const events = deps.ctx.sessionPersistence.prepare(SessionId(SESSION_ID)) ?? []
        for (const ev of events) {
          if (ev.type === 'assistant/chunk') {
            const chunk = ev.data.chunk
            if (chunk?.type === 'thinking-delta' && typeof chunk.text === 'string') {
              const stepKey = `turn-${ev.data.turn}-${ev.data.step}`
              thinkingByStep.set(stepKey, (thinkingByStep.get(stepKey) ?? '') + chunk.text)
            }
            continue
          }
          if (ev.type === 'tool/result') {
            const stepKey = `turn-${ev.data.turn}-${ev.data.step}`
            const idx = msgIndexByStep.get(stepKey)
            if (idx === undefined) continue
            const msg = messages[idx] as { tools?: Array<Record<string, unknown>> }
            const list = msg.tools ? [...msg.tools] : []
            const callId = ev.data.callId !== undefined ? String(ev.data.callId)
              : (ev.data.message?.callId !== undefined ? String(ev.data.message.callId) : undefined)
            const raw = String(ev.data.message?.content ?? '')
            const summary = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
            const isError = ev.data.message?.isError === true
            const hit = list.findIndex((t) => callId !== undefined && t.callId === callId)
            if (hit >= 0) {
              list[hit] = {
                ...list[hit],
                status: 'result',
                ...(summary !== '' ? { summary } : {}),
                isError,
              }
            } else {
              list.push({
                name: 'tool',
                status: 'result',
                time: Number(ev.time) || Date.now(),
                ...(callId !== undefined ? { callId } : {}),
                ...(summary !== '' ? { summary } : {}),
                isError,
              })
            }
            messages[idx] = { ...msg, tools: list }
            continue
          }
          if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
          const time = Number(ev.time) || Date.now()
          if (ev.type === 'user/message') {
            // 过滤运行时上下文快照；放行真人消息与桌宠互动痕迹
            const interaction = isInteractionUserMessage(ev.data.source)
            if (ev.data.source?.kind !== 'human' && !interaction) continue
            const text = textOf(ev.data.content)
            if (interaction) {
              messages.push({
                id: ev.data.id, kind: 'system',
                content: '（互动）',
                origin: 'interaction', time,
              })
            } else if (text.startsWith('[presence]')) {
              presencePending = true
              messages.push({
                id: ev.data.id, kind: 'system',
                content: text.replace(/^\[presence\]\s*/, '').trim(),
                origin: 'presence', time,
              })
            } else {
              messages.push({
                id: ev.data.id,
                kind: 'user',
                content: text,
                origin: 'user',
                time,
                ...(imagesOf(ev.data.content).length > 0 ? { images: imagesOf(ev.data.content) } : {}),
              })
            }
          } else if (ev.type === 'assistant/message') {
            const text = textOf(ev.data.message.content)
            const stepKey = `turn-${ev.data.turn}-${ev.data.step}`
            const thinking = thinkingByStep.get(stepKey) ?? ''
            // assistant 消息中的 tool-call 块 → 工具记录（结果由后续 tool/result 回填）
            const blocks = Array.isArray(ev.data.message.content) ? ev.data.message.content : []
            const tools = blocks
              .filter((b: any) => b && (b.type === 'tool-call' || b.type === 'toolCall'))
              .map((b: any) => ({
                name: String(b.name ?? 'tool'),
                status: 'call',
                time,
                ...(b.id !== undefined ? { callId: String(b.id) } : {}),
              }))
            // 无文本、无思考、无工具的步骤不进历史，避免空气泡
            if (text === '' && thinking === '' && tools.length === 0) {
              presencePending = false
              continue
            }
            messages.push({
              id: ev.data.message.id, kind: 'assistant',
              content: text,
              ...(thinking !== '' ? { thinking } : {}),
              ...(tools.length > 0 ? { tools } : {}),
              origin: presencePending ? 'presence' : 'assistant', time,
            })
            msgIndexByStep.set(stepKey, messages.length - 1)
            presencePending = false
          }
        }
      } catch { /* 会话尚不存在 */ }
      sendJson(res, 200, { messages: messages.slice(-200) })
      return
    }

    // ── 阶段 1 通道收敛：插件 / profile / native 走 backend HTTP（UI 不再 invoke） ──

    // GET /api/plugins
    if (pathname === '/api/plugins' && req.method === 'GET') {
      const plugins = listPlugins()
      deps.state.plugins = plugins
      sendJson(res, 200, {
        activeProfile: readActiveProfile(),
        plugins,
      })
      return
    }

    // POST /api/plugins/toggle  { id, enabled, restart? }
    if (pathname === '/api/plugins/toggle' && req.method === 'POST') {
      const body = await readBody(req)
      const id = String(body.id ?? '').trim()
      const enabled = !!body.enabled
      const restart = body.restart !== false
      if (!id) {
        sendJson(res, 400, { error: 'id 必填' })
        return
      }
      const plugins = toggleWithBroadcast(
        id,
        enabled,
        deps.state,
        (e) => broadcastLocal(deps, e),
      )
      sendJson(res, 200, { plugins, activeProfile: readActiveProfile(), restart })
      if (restart) {
        setTimeout(() => {
          void gracefulExitForRestart()
        }, 100)
      }
      return
    }

    // POST /api/plugins/install { spec, restart? }
    if (pathname === '/api/plugins/install' && req.method === 'POST') {
      const body = await readBody(req)
      const spec = String(body.spec ?? '').trim()
      const restart = body.restart !== false
      if (!spec) {
        sendJson(res, 400, { error: 'spec 必填' })
        return
      }
      try {
        const plugins = await installProfilePlugin(spec, deps.state, (e) =>
          broadcastLocal(deps, e),
        )
        sendJson(res, 200, { plugins, activeProfile: readActiveProfile(), restart })
        if (restart) {
          setTimeout(() => {
            void gracefulExitForRestart()
          }, 100)
        }
      } catch (e) {
        sendJson(res, 500, { error: String((e as Error)?.message ?? e) })
      }
      return
    }

    // POST /api/plugins/uninstall { id, restart? }
    if (pathname === '/api/plugins/uninstall' && req.method === 'POST') {
      const body = await readBody(req)
      const id = String(body.id ?? '').trim()
      const restart = body.restart !== false
      if (!id) {
        sendJson(res, 400, { error: 'id 必填' })
        return
      }
      try {
        const plugins = await uninstallProfilePlugin(id, deps.state, (e) =>
          broadcastLocal(deps, e),
        )
        sendJson(res, 200, { plugins, activeProfile: readActiveProfile(), restart })
        if (restart) {
          setTimeout(() => {
            void gracefulExitForRestart()
          }, 100)
        }
      } catch (e) {
        sendJson(res, 500, { error: String((e as Error)?.message ?? e) })
      }
      return
    }

    // GET /api/profile
    if (pathname === '/api/plugins/config' && req.method === 'GET') {
      const { listPluginConfigs } = await import('./plugin-config.ts')
      return sendJson(res, 200, { plugins: await listPluginConfigs() })
    }

    if (pathname === '/api/plugins/config' && req.method === 'POST') {
      const body = await readBody(req)
      if (typeof body.id !== 'string' || body.id === '') {
        return sendJson(res, 400, { error: 'id is required' })
      }
      const { savePluginConfig } = await import('./plugin-config.ts')
      const result = await savePluginConfig(body.id, body.values ?? {})
      requestRestart()
      return sendJson(res, 200, result)
    }

    if (pathname === '/api/profile' && req.method === 'GET') {
      sendJson(res, 200, await getProfile())
      return
    }

    // POST /api/profile { profile: companion|safe, restart? }
    if (pathname === '/api/profile' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const result = await setProfile(String(body.profile ?? COMPANION_PROFILE))
        ensureProfile()
        sendJson(res, 200, { ...result, restart: body.restart !== false })
        if (body.restart !== false) {
          setTimeout(() => {
            void gracefulExitForRestart()
          }, 100)
        }
      } catch (e) {
        sendJson(res, 400, { error: String((e as Error)?.message ?? e) })
      }
      return
    }

    // GET /api/native/status
    if (pathname === '/api/native/status' && req.method === 'GET') {
      sendJson(res, 200, await nativeStatus())
      return
    }

    // GET /api/presence —— 日程提醒配置（presence schedule，持久化于 $COS_HOME）
    if (pathname === '/api/presence' && req.method === 'GET') {
      sendJson(res, 200, loadSchedule())
      return
    }

    // POST /api/presence —— 保存日程配置（整个数组替换，热生效无需重启）
    if (pathname === '/api/presence' && req.method === 'POST') {
      const body = await readBody(req)
      const raw = Array.isArray(body.entries) ? body.entries : Array.isArray(body) ? body : []
      const entries = raw
        .filter((e) => e && typeof e === 'object')
        .map((e: Record<string, unknown>) => ({
          id: String(e.id ?? ''),
          time: String(e.time ?? ''),
          prompt: String(e.prompt ?? ''),
          enabled: e.enabled !== false,
        }))
      sendJson(res, 200, saveSchedule(entries))
      return
    }

    // /api/settings GET / POST
    if (pathname === '/api/settings') {
      if (req.method === 'GET') {
        const h = await deps.healthInfo()
        sendJson(res, 200, {
          modelConfigured: h.modelConfigured,
          // provider/model 来自持久化选择；model 未设置时才回退目录第一个
          provider: h.provider,
          model: h.model,
          models: await deps.catalogModels(),
          providers: await deps.providerDecls(),
          petInteraction: readPetInteractionSettings(),
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
        if (body.petInteraction && typeof body.petInteraction === 'object') {
          const cur = readPetInteractionSettings()
          const src = body.petInteraction as Record<string, unknown>
          const mode = src.mode
          const nextMode =
            mode === 'off' || mode === 'events' || mode === 'context' ? mode : cur.mode
          const numOr = (v: unknown, fallback: number) =>
            typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
          patch.petInteraction = {
            mode: nextMode,
            quietMs: numOr(src.quietMs, cur.quietMs),
            cooldownMs: numOr(src.cooldownMs, cur.cooldownMs),
            maxTriggers: numOr(src.maxTriggers, cur.maxTriggers),
            longHoldMs: numOr(src.longHoldMs, cur.longHoldMs),
          }
        }
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
        sendJson(res, 200, {
          modelConfigured: h.modelConfigured,
          provider: h.provider,
          model: h.model,
          petInteraction: readPetInteractionSettings(),
        })
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