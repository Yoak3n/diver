// @diver/onebot — OneBot 11 接入（潜水 / @必回 / 偶尔插话）。
//
// 装配层：客户端生命周期、安全钩子（回合收权双闸）、工具与提示词挂载。
// 业务规则在纯函数模块（protocol/trigger/context/sandbox/mask），入站路由在
// router.ts。
//
// 接入：bundle insert `{ id: onebot, name: '@diver/onebot' }`；配置见 config.ts。

import type { Context } from 'cordis'

import { configDecl, resolveConfig, type Config } from './config.ts'
import { groupBufferPath, trimBuffer } from './buffer-store.ts'
import { TurnSandbox, allowedToolNames, filterToolsForTurn, vetoIfActive } from './sandbox.ts'
import { OnebotClient } from './ws.ts'
import { applyTools } from './tools.ts'
import { applyPrompt } from './prompt.ts'
import { createRouter, type CompanionLike } from './router.ts'

export const name = 'onebot'

export const inject = ['companion', 'tools', 'systemPrompt']

export { configDecl }

export function apply(ctx: Context, config: Config = {}): void {
  const cfg = resolveConfig(config)
  if (cfg.wsUrl === '') {
    console.log('[onebot] 未配置 wsUrl，插件休眠（设置「OneBot 11」后重启 sidecar 生效）')
    return
  }
  const companionRaw = (ctx as Context & { companion?: CompanionLike }).companion
  if (companionRaw === undefined) {
    console.warn('[onebot] ctx.companion 不可用（backend 未挂载？），插件休眠')
    return
  }
  const companion = companionRaw

  const sandbox = new TurnSandbox()
  const allowed = allowedToolNames(cfg.sandbox.allowedTools)
  let selfId = 0

  // ---- 安全钩子：可见性 + 执行双闸 ----
  // 回合来源由 router 唤醒消息的 `onebot:` detail 标记（inbox/claimed 判定）。

  ctx.on('system-prompt/assemble', (assembly, _context, next) => {
    if (sandbox.isActive()) {
      assembly.tools = filterToolsForTurn(assembly.tools, true, allowed)
    }
    return next()
  })

  ctx.on('tools/pre-execute', (payload, next) => {
    const veto = vetoIfActive(payload.name, sandbox.isActive(), allowed)
    return veto === undefined ? next() : Promise.resolve({ veto })
  })

  ctx.on('agent/inbox/claimed', (payload) => {
    sandbox.markClaimed([payload.message])
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'turn/end') return
    sandbox.markTurnEnd()
    router.settleTurn()
  })

  // ---- 客户端 + 入站路由 + 出话工具 ----

  const client = new OnebotClient({
    url: cfg.wsUrl,
    token: cfg.token,
    onGroupMessage: (event) => void router.handleGroup(event),
    onPrivateMessage: (event) => void router.handlePrivate(event),
    onStatus: (status) => {
      if (status !== 'connected') return
      client.call<{ user_id?: number }>('get_login_info', {}, 5000)
        .then((data) => {
          const id = Number(data?.user_id ?? 0)
          if (id > 0) {
            selfId = id
            console.log(`[onebot] 登录账号 ${selfId}`)
          }
        })
        .catch(() => { /* 拿不到只影响日志；回声过滤用事件自带 self_id */ })
    },
  })

  const router = createRouter({ companion, cfg, client })

  applyTools(ctx, {
    client,
    cfg,
    anchor: router.anchor,
    rememberSent: router.rememberSent,
    onSpoke: router.noteSpoke,
  })

  applyPrompt(ctx)

  // ---- 生命周期 ----

  ctx.effect(() => () => {
    client.stop()
    router.clearTimers()
  }, 'onebot.lifecycle')

  // 启动压缩（每群/私聊只保留最近 2000 行）+ 建连
  for (const groupId of cfg.groups) trimBuffer(groupBufferPath(groupId))
  client.start()
  console.log(
    `[onebot] 就绪 ${cfg.wsUrl}（群：${cfg.groups.length > 0 ? cfg.groups.join(',') : '未配置'}；` +
    `上下文 ${cfg.context.maxMessages} 条/${cfg.context.maxAgeMinutes} 分钟；` +
    `插话概率 ${cfg.rate.plain}）`,
  )
}
