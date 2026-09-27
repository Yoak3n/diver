// @diver/backend — HTTP 原语：JSON 请求/响应、静态资源、SSE 广播（backend/ 子模块）。

import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

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

export function sendJson(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** 向全部 SSE 客户端广播同一事件（UI 侧经 /api/stream 收到）。 */
export function broadcastLocal(deps: WebHandlerDeps, event: unknown) {
  for (const client of [...deps.state.clients]) deps.sseWrite(client, event)
}

export async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, uiDist: string) {
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
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}
