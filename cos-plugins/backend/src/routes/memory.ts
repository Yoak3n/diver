// @diver/backend — 记忆探索端点（§7.4 执行面；时机/选词由壳 ExplorePolicy 裁决）。

import { exploreJobs, pickTerms } from '@diver/memory/explore'
import { MemoryStore } from '@diver/memory/store-rpc'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { readBody, sendJson } from '../http.ts'
import type { WebHandlerDeps } from '../types.ts'

/** 命中并处理返回 true；未命中返回 false 交回分发器。 */
export async function handleMemory(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: WebHandlerDeps,
): Promise<boolean> {
  // GET /api/memory/pick-terms —— 只读挑候选词
  if (pathname === '/api/memory/pick-terms' && req.method === 'GET') {
    const store = new MemoryStore('')
    const limit = Number(new URL(req.url ?? '', 'http://x').searchParams.get('limit') ?? 5) || 5
    const terms = await pickTerms(store, limit)
    sendJson(res, 200, { terms })
    return true
  }

  // POST /api/memory/explore —— 启动探索 job（202）
  if (pathname === '/api/memory/explore' && req.method === 'POST') {
    const body = await readBody(req)
    const term = String(body.term ?? '').trim()
    if (!term) {
      sendJson(res, 400, { error: 'term 必填' })
      return true
    }
    const store = new MemoryStore('')
    try {
      const job = exploreJobs.start(store, {
        term,
        ...(body.reason ? { reason: String(body.reason) } : {}),
        ...(body.fromMemoryId ? { fromMemoryId: String(body.fromMemoryId) } : {}),
        ...(body.hint ? { hint: String(body.hint) } : {}),
        ...(body.policy ? { policy: body.policy as never } : {}),
      })
      sendJson(res, 202, { jobId: job.jobId, term: job.term, state: job.state })
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      const code = msg.startsWith('EXPLORE_BUSY') ? 409 : 500
      sendJson(res, code, { error: msg })
    }
    return true
  }

  // GET /api/memory/explore —— 列表（调试）
  if (pathname === '/api/memory/explore' && req.method === 'GET') {
    sendJson(res, 200, { jobs: exploreJobs.list() })
    return true
  }

  // GET /api/memory/explore/:id
  {
    const m = /^\/api\/memory\/explore\/([A-Za-z0-9-]+)$/.exec(pathname)
    if (m && req.method === 'GET') {
      const job = exploreJobs.status(m[1])
      if (!job) {
        sendJson(res, 404, { error: 'job not found' })
        return true
      }
      sendJson(res, 200, job)
      return true
    }
  }

  // POST /api/memory/explore/:id/cancel —— USER_CHAT / 用户打断
  {
    const m = /^\/api\/memory\/explore\/([A-Za-z0-9-]+)\/cancel$/.exec(pathname)
    if (m && req.method === 'POST') {
      const ok = exploreJobs.cancel(m[1])
      sendJson(res, 200, { ok, jobId: m[1] })
      return true
    }
  }

  return false
}
