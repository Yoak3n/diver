// @diver/backend — OneBot 运行时连接状态（设置「QQ 接入」页状态灯）。
//
// onebot 插件把连接状态注册为 cordis 服务 `onebotStatus`（见 @diver/onebot
// status.ts）。插件休眠（未配置 wsUrl / 非归属实例）时服务仍在，state 为
// sleeping；插件被停用或未加载时服务不存在，available=false。
//
// 只读、不落盘：状态来自同一 sidecar 进程内的实时快照。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { sendJson } from '../http.ts'
import type { WebHandlerDeps } from '../types.ts'

export interface ServiceLookup {
  get(name: string): unknown
}

interface OnebotStatusServiceLike {
  snapshot?: () => Record<string, unknown>
}

/** 服务快照 → IPC 视图；缺服务/快照异常一律降级成 unavailable，不让状态灯拖垮配置面。 */
export function onebotStatusView(ctx: ServiceLookup): Record<string, unknown> {
  const service = ctx.get('onebotStatus') as OnebotStatusServiceLike | undefined
  if (service === undefined || typeof service.snapshot !== 'function') {
    return { available: false, state: 'unavailable' }
  }
  try {
    return { available: true, ...service.snapshot() }
  } catch (error) {
    return {
      available: false,
      state: 'unavailable',
      error: String((error as { message?: unknown } | null)?.message ?? error),
    }
  }
}

export function handleOnebotStatus(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: WebHandlerDeps,
): boolean {
  if (pathname !== '/api/plugins/onebot/status' || req.method !== 'GET') return false
  sendJson(res, 200, onebotStatusView(deps.ctx))
  return true
}
