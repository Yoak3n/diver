// @diver/backend — 设置端点：模型/提供商选择 + 互动感知档位（设置页读写面）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readBody, sendJson } from '../http.ts'
import { readPetInteractionSettings } from '../interaction.ts'
import { readDiverSettings, writeDiverSettings } from '../session-helpers.ts'
import type { WebHandlerDeps } from '../types.ts'

/** 命中并处理返回 true；未命中返回 false 交回分发器。 */
export async function handleSettings(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: WebHandlerDeps,
): Promise<boolean> {
  // /api/settings GET / POST
  if (pathname !== '/api/settings') return false
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
    return true
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
    return true
  }
  return false
}
