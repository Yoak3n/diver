// @diver/backend — 模型目录端点（GET /api/models）。
//
// 与 /api/settings 首屏解耦：这里会等待上游目录（各适配器最多数秒），
// 设置面板在提供商卡片渲染完成后再补拉，把网络等待挪出关键路径。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { sendJson } from '../http.ts'
import type { WebHandlerDeps } from '../types.ts'

/** 命中并处理返回 true；未命中返回 false 交回分发器。 */
export async function handleModels(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: WebHandlerDeps,
): Promise<boolean> {
  if (pathname !== '/api/models' || req.method !== 'GET') return false
  // 显式请求 = 用户正在看模型下拉：强制刷新（仍与后台刷新共享同一个 in-flight）。
  sendJson(res, 200, { models: await deps.catalog.refresh({ force: true }) })
  return true
}
