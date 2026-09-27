// @diver/backend — HTTP 路由分发（backend/ 子模块）。
// 只做安全门与域委派，不写业务分支：Host/CORS/预检/token 校验后，按域尝试
// routes/*（各域自带 pathname/method 匹配，未命中返回 false 交回），
// 全部未命中回落静态 UI / 404。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { applyCors, corsOriginAllowed, hostAllowed, tokenOk } from './auth.ts'
import { sendJson, serveStatic } from './http.ts'
import { handleChat } from './routes/chat.ts'
import { handleHistory } from './routes/history.ts'
import { handleMemory } from './routes/memory.ts'
import { handlePlugins } from './routes/plugins.ts'
import { handlePresence } from './routes/presence.ts'
import { handleProviders } from './routes/providers.ts'
import { handleSettings } from './routes/settings.ts'
import { handleSystem } from './routes/system.ts'
import type { WebHandlerDeps } from './types.ts'

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: WebHandlerDeps,
) {
  const pathname = url.pathname

  // P2-1 / BUG-002：Host 必须回环名（防 DNS rebinding），全路由适用。
  if (!hostAllowed(req.headers.host)) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  applyCors(req, res)

  if (req.method === 'OPTIONS') {
    // 预检：仅受信 origin 放行；未授权 origin 无 CORS 头，浏览器自会拦截。
    res.writeHead(corsOriginAllowed(req.headers.origin) ? 204 : 403)
    res.end()
    return
  }

  // P2-1 / BUG-002：/api 一律要求 Bearer 令牌 —— GET /api/health（只读探测）与
  // /api/shutdown（自带 DIVER_SHUTDOWN_TOKEN 校验）除外；SSE 可用 ?token=。
  if (pathname.startsWith('/api/')) {
    const exempt =
      (req.method === 'GET' && pathname === '/api/health') ||
      (req.method === 'POST' && pathname === '/api/shutdown')
    if (!exempt && !tokenOk(req, url, process.env.DIVER_TOKEN ?? '')) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
  }

  try {
    if (await handleSystem(req, res, pathname, deps)) return
    if (await handleChat(req, res, pathname, deps)) return
    if (await handleMemory(req, res, pathname, deps)) return
    if (await handleHistory(req, res, pathname, deps)) return
    if (await handlePlugins(req, res, pathname, deps)) return
    if (await handlePresence(req, res, pathname, deps)) return
    if (await handleProviders(req, res, pathname, deps)) return
    if (await handleSettings(req, res, pathname, deps)) return

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
