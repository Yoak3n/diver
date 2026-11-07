// @diver/backend — 设置端点：模型/提供商选择 + 互动感知档位（设置页读写面）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readBody, sendJson } from '../http.ts'
import { readPetInteractionSettings } from '../interaction.ts'
import {
  DEFAULT_PROVIDER_CARDS,
  appendProviderCard,
  dropProviderCard,
  normalizeProviderCards,
  readProviderCards,
  seedProviderCards,
  writeProviderCards,
} from '../provider-cards.ts'
import { readDiverSettings, writeDiverSettings } from '../session-helpers.ts'
import type { WebHandlerDeps } from '../types.ts'

/**
 * 卡片列表：未初始化时按当前状态播种（默认项 + 已配置/自定义 provider），
 * 老用户升级不会把已经在用的 provider 藏起来。
 */
async function ensureProviderCards(deps: WebHandlerDeps): Promise<string[]> {
  const stored = readProviderCards()
  if (stored !== undefined) return stored
  return writeProviderCards(seedProviderCards(await deps.providerDecls()))
}

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
    // 首屏只带目录快照：上游 /models 的实时拉取放到后台（/api/models 由设置页
    // 在渲染完成后显式等待），否则单家数秒超时会把提供商卡片一起拖住。
    void deps.catalog.refresh()
    sendJson(res, 200, {
      modelConfigured: h.modelConfigured,
      // provider/model 来自持久化选择；model 未设置时才回退目录第一个
      provider: h.provider,
      model: h.model,
      models: deps.catalog.snapshot(),
      providers: await deps.providerDecls(),
      // 设置面板的提供商卡片（UI 可见性状态；默认名单由 UI 决定）
      providerCards: await ensureProviderCards(deps),
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
    // 卡片增删走增量：客户端只发「加/减一张」，后端读改写，陈旧快照不会抹掉别的卡片。
    const add = typeof body.addProvider === 'string' ? body.addProvider.trim() : ''
    const remove = typeof body.removeProvider === 'string' ? body.removeProvider.trim() : ''
    const cards = add !== ''
      ? appendProviderCard(readProviderCards() ?? [...DEFAULT_PROVIDER_CARDS], add)
      : remove !== ''
        ? dropProviderCard(readProviderCards() ?? [...DEFAULT_PROVIDER_CARDS], remove)
        : normalizeProviderCards(body.providerCards)
    if (cards !== undefined) {
      patch.providerCards = cards
      // 旧字段名一次性清掉（JSON.stringify 省略 undefined 键）
      patch.addedProviders = undefined
    }
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
      providerCards: readProviderCards() ?? [],
      petInteraction: readPetInteractionSettings(),
    })
    return true
  }
  return false
}
