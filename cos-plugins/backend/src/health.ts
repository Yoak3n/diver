// @diver/backend — 健康信息组装（与传输层解耦，纯查询）。

import type { Context } from 'cordis'

import type { ModelCatalog } from './model-catalog.ts'
import { activeProvider, isConfigured } from './providers.ts'
import { readDiverSettings } from './session-helpers.ts'
import type { WebState } from './state.ts'

export async function healthInfo(ctx: Context, state: WebState, catalog: ModelCatalog) {
  const provider = (await activeProvider(ctx)) ?? ''
  // 模型以用户持久化选择为准；仅未设置时才回退该 provider 目录的第一个（advisory）。
  // 不要总是返回 firstModelOf——保存后回填会把用户选的模型冲掉。
  // 目录读快照：健康检查也在设置页首屏路径上，不能等上游 /models。
  const settings = readDiverSettings()
  const persistedModel =
    typeof settings.model === 'string' && settings.model !== '' ? settings.model : undefined
  const catalogModel = catalog.snapshot().find((entry) => entry.provider === provider)?.id
  const model = provider ? (persistedModel ?? catalogModel ?? '') : ''
  return {
    ok: true,
    persona: '',
    provider,
    model,
    modelConfigured: await isConfigured(ctx, provider),
    memoryPort: Number(process.env.DIVER_MEMORY_PORT ?? 0),
    sessionId: state.agent ? String(state.agent.id) : null,
    busy: state.busy,
  }
}