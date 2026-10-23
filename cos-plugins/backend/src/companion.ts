// @diver/backend — 陪伴 agent 服务（ctx.companion）。
//
// 把「取用单例陪伴 agent + 构造入站用户消息」收敛为一个 cordis 服务，供产品内
// 其它插件（如 onebot）注入驱动同一个会话——避免各插件重复 provider 解析与
// ensure 缓存（agent.ts 的 WebState 缓存复用，模型切换释放后下次重建同会话）。
//
// 边界：只暴露 Agent 与 UserMessage；WebState / HTTP 传输细节不出 backend。

import { Service } from 'cordis'
import type { Context } from 'cordis'
import { createUserMessage } from '@cos/plugin-api'
import type { Agent, UserMessage } from '@cos/plugin-api'

import { ensureAgent } from './agent.ts'
import type { WebState } from './state.ts'

declare module 'cordis' {
  interface Context {
    companion: CompanionService
  }
}

/** 消息来源 detail 约定（与 backend 路由的 group:<gid> / peer:<uid> 同形）。 */
export type CompanionDetail = string

export class CompanionService extends Service {
  static inject: string[] = []

  constructor(
    ctx: Context,
    private readonly ensure: () => Promise<Agent>,
  ) {
    super(ctx, 'companion')
  }

  /** 惰性确保单例陪伴 agent（复用 backend 传输层缓存；不存在则按设置创建/resume）。 */
  agent(): Promise<Agent> {
    return this.ensure()
  }

  /**
   * 构造一条入站用户消息：kind=human，`detail` 盖来源（如 `onebot:g123:456`，
   * 前缀即回合来源判定依据），`id` 可选（跨端去重，如 OneBot message_id）。
   */
  message(text: string, detail?: CompanionDetail, id?: string): UserMessage {
    return createUserMessage(
      text,
      detail ? { kind: 'human', detail } : { kind: 'human' },
      undefined,
      id,
    )
  }
}

/** 在 backend apply 时挂载（传入传输层 ensure 闭包）。 */
export function mountCompanionService(ctx: Context, state: WebState): void {
  new CompanionService(ctx, () => ensureAgent(ctx, state))
}
