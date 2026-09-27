// @diver/backend — 自定义模型提供商端点（身份 CRUD；热生效 ≤2s）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  addCustomProvider,
  listCustomProviders,
  probeProviderModels,
  removeCustomProvider,
  updateCustomProvider,
} from '../custom-providers.ts'
import { readBody, sendJson } from '../http.ts'
import type { WebHandlerDeps } from '../types.ts'

/** 命中并处理返回 true；未命中返回 false 交回分发器。 */
export async function handleProviders(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: WebHandlerDeps,
): Promise<boolean> {
  // /api/custom-providers —— 身份 CRUD
  if (pathname === '/api/custom-providers') {
    if (req.method === 'GET') {
      sendJson(res, 200, { providers: listCustomProviders() })
      return true
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      const input = {
        name: String(body.name ?? ''),
        ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
        ...(typeof body.models === 'string' ? { models: body.models } : {}),
      }
      try {
        const action = String(body.action ?? 'add')
        if (action === 'remove') {
          sendJson(res, 200, { ok: removeCustomProvider(String(body.id ?? '')) })
        } else if (action === 'update') {
          const identity = updateCustomProvider(deps.ctx, String(body.id ?? ''), input)
          sendJson(res, identity === undefined ? 404 : 200, identity === undefined ? { error: 'not found' } : { ok: true, provider: identity })
        } else {
          sendJson(res, 200, { ok: true, provider: addCustomProvider(deps.ctx, input) })
        }
      } catch (error) {
        sendJson(res, 400, { error: String((error as Error).message ?? error) })
      }
      return true
    }
    return false
  }

  // POST /api/custom-providers/models —— 「拉取模型」：探端点 /models 目录
  if (pathname === '/api/custom-providers/models' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const models = await probeProviderModels(
        String(body.baseUrl ?? ''),
        typeof body.apiKey === 'string' ? body.apiKey : undefined,
      )
      sendJson(res, 200, { models })
    } catch (error) {
      sendJson(res, 502, { error: String((error as Error).message ?? error) })
    }
    return true
  }

  return false
}
