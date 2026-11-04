// @diver/backend — 记忆探索端点（§7.4 执行面；时机/选词由壳 ExplorePolicy 裁决）。

import { exploreJobs, pickTerms } from '@diver/memory/explore'
import { readCuriosityState } from '@diver/memory/curiosity-state'
import { MemoryStore, type CuriosityStatus } from '@diver/memory/store-rpc'
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

  // GET /api/memory/curiosity —— 好奇心清单（只读；设置页展示）
  if (pathname === '/api/memory/curiosity' && req.method === 'GET') {
    const url = new URL(req.url ?? '', 'http://x')
    const rawStatus = url.searchParams.get('status')
    const status: CuriosityStatus | undefined =
      rawStatus === 'open' || rawStatus === 'claimed' || rawStatus === 'done' ||
      rawStatus === 'skipped' || rawStatus === 'expired'
        ? rawStatus
        : undefined
    const limit = Number(url.searchParams.get('limit') ?? 50) || 50
    const store = new MemoryStore('')
    try {
      const [items, counts] = await Promise.all([
        store.curiosityList(status, limit),
        store.curiosityCounts(),
      ])
      const state = readCuriosityState()
      sendJson(res, 200, {
        items,
        counts,
        report: state.report ?? null,
        lastScanAt: state.lastScanAt,
      })
    } catch (err) {
      sendJson(res, 500, { error: String((err as Error)?.message ?? err) })
    }
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
        ...(body.fromCuriosityId ? { fromCuriosityId: String(body.fromCuriosityId) } : {}),
        ...(body.hint ? { hint: String(body.hint) } : {}),
        ...(body.payload ? { payload: String(body.payload) } : {}),
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
