// @diver/backend — 健康信息组装（与传输层解耦，纯查询）。

import type { Context } from 'cordis'

import { activeProvider, firstModelOf, isConfigured } from './providers'
import type { WebState } from './state'

export async function healthInfo(ctx: Context, state: WebState) {
  const provider = (await activeProvider(ctx)) ?? ''
  const model = provider ? (await firstModelOf(ctx, provider)) ?? '' : ''
  return {
    ok: true,
    persona: '小潜',
    provider,
    model,
    modelConfigured: await isConfigured(ctx, provider),
    memoryPort: Number(process.env.DIVER_MEMORY_PORT ?? 0),
    sessionId: state.agent ? String(state.agent.id) : null,
    busy: state.busy,
  }
}