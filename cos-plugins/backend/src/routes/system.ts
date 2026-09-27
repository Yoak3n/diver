// @diver/backend — 进程级端点：SSE 事件流 / 健康探测 / 优雅退出。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readBody, sendJson } from '../http.ts'
import type { WebHandlerDeps } from '../types.ts'

/** 命中并处理返回 true；未命中返回 false 交回分发器。 */
export async function handleSystem(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: WebHandlerDeps,
): Promise<boolean> {
  // /api/stream —— SSE 事件流
  if (pathname === '/api/stream' && req.method === 'GET') {
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
    return true
  }

  // /api/health
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, await deps.healthInfo())
    return true
  }

  // /api/shutdown —— 优雅退出（仅限本应用：必须携带 DIVER_SHUTDOWN_TOKEN）。
  // Tauri 壳退出时调用：触发 Node 侧 settle() 完整 dispose agent 树后 exit(0)，
  // 避免强杀导致孤儿进程/未落盘的会话状态。令牌不匹配直接 403，静默返回。
  if (pathname === '/api/shutdown' && req.method === 'POST') {
    const body = await readBody(req)
    const expected = process.env.DIVER_SHUTDOWN_TOKEN ?? ''
    if (expected === '' || body.token !== expected) {
      sendJson(res, 403, { error: 'forbidden' })
      return true
    }
    sendJson(res, 200, { ok: true })
    // 延迟一瞬再退出：先把 200 响应 flush 给调用方，随后走 signal 路径
    // 触发 companion 的 settle()（与 Ctrl+C / 任务结束一致，agent 树完整 dispose）。
    setTimeout(() => {
      process.kill(process.pid, 'SIGTERM')
    }, 50)
    return true
  }

  return false
}
