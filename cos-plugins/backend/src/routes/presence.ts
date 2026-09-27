// @diver/backend — 日程提醒配置端点（presence schedule，持久化于 $COS_HOME）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readBody, sendJson } from '../http.ts'
import { loadSchedule, saveSchedule } from '../presence.ts'
import type { WebHandlerDeps } from '../types.ts'

/** 命中并处理返回 true；未命中返回 false 交回分发器。 */
export async function handlePresence(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _deps: WebHandlerDeps,
): Promise<boolean> {
  if (pathname !== '/api/presence') return false

  // GET /api/presence
  if (req.method === 'GET') {
    sendJson(res, 200, loadSchedule())
    return true
  }

  // POST /api/presence —— 保存日程配置（整个数组替换，热生效无需重启）
  if (req.method === 'POST') {
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
    return true
  }

  return false
}
