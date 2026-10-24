// @diver/onebot — OneBot 11 接入（潜水 / @必回 / 偶尔插话）。
//
// 装配层：客户端生命周期、安全钩子（回合收权双闸）、工具与提示词挂载。
// 业务规则在纯函数模块（protocol/trigger/context/sandbox/mask），入站路由在
// router.ts。
//
// 接入：bundle insert `{ id: onebot, name: '@diver/onebot' }`；配置见 config.ts。

import type { Context } from 'cordis'
import { nativeRpc } from '@diver/native-bridge/rpc'

import { configDecl, ownerGate, resolveConfig, type Config } from './config.ts'
import { trimAllBuffers } from './buffer-store.ts'
import {
  TurnSandbox,
  allowedToolNames,
  allowedToolNamesForSource,
  filterToolsForTurn,
  vetoIfActive,
  type OnebotSource,
  type TurnScopeEvent,
} from './sandbox.ts'
import { OnebotClient } from './ws.ts'
import { applyTools, type VoiceSendDeps } from './tools.ts'
import { applyPrompt } from './prompt.ts'
import { replaceRelationCard, safeRelationCard, type ShallowCardFacts } from './relation-card.ts'
import { createRouter, type CompanionLike } from './router.ts'
import { voiceCooldownOk } from './voice.ts'

export const name = 'onebot'

export const inject = ['companion', 'tools', 'systemPrompt']

export { configDecl }

/** 单次 RPC 超时包装（语音合成可能挂住；超时后降级发文本）。 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  // 归属闸门（先于 wsUrl 判定）：壳层绑定了 QQ 归属实例时，非归属实例一律休眠，
  // 多实例配同一 wsUrl 也不会出现双回复；未绑定保持旧「配置即归属」行为。
  // （变量名避开下方登录账号 selfId——那是 OneBot 侧 QQ 号，与本实例 id 无关。）
  const onebotOwner = (process.env.DIVER_ONEBOT_OWNER ?? '').trim()
  const myInstanceId = (process.env.DIVER_INSTANCE_ID ?? '').trim()
  if (!ownerGate(onebotOwner, myInstanceId)) {
    console.log(`[onebot] QQ 已绑定实例 ${onebotOwner}（本实例 ${myInstanceId || '?'}），插件休眠`)
    return
  }
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
  const allowedForTurn = (source: OnebotSource | undefined): string[] =>
    allowedToolNamesForSource(allowed, source, cfg.ownerIds)
  let selfId = 0
  /** 本回合主会话 id：避免 subagent 的 turn/end 提前解除沙箱。 */
  let activeSessionId: string | undefined
  /** 每回合只读一次身份卡片：只取名字；性格/说话方式由 self-prompt 的 prompts 负责。 */
  let turnCardFacts: Promise<ShallowCardFacts> | undefined

  const loadShallowCard = (): Promise<ShallowCardFacts> => {
    turnCardFacts ??= withTimeout(
      nativeRpc<{ name?: string | null }>('get_card', {}, { label: 'memory:get_card' }),
      1_500,
      '读取身份卡片超时',
    )
      .then((card) => ({ name: card?.name ?? '' }))
      .catch(() => ({ name: '' }))
    return turnCardFacts
  }

  /** 把来源转成记忆插件可消费的作用域事件（主人标记只影响提示词/记忆，不升权）。 */
  const scopeEvent = (source: OnebotSource | undefined): TurnScopeEvent => source === undefined
    ? { active: false }
    : {
        active: true,
        kind: source.kind,
        userId: source.userId,
        ...(source.kind === 'group' ? { groupId: source.groupId } : {}),
        isOwner: cfg.ownerIds.includes(source.userId),
      }

  // ---- 安全钩子：可见性 + 执行双闸 + QQ 安全卡片 ----
  // 回合来源由 router 唤醒消息的 `onebot:` detail 标记（inbox/claimed 判定）。

  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    if (sandbox.isActive()) {
      const source = sandbox.currentSource()
      assembly.tools = filterToolsForTurn(assembly.tools, true, allowedForTurn(source))
      if (source !== undefined) {
        const facts = await loadShallowCard()
        assembly.sections = replaceRelationCard(
          assembly.sections,
          safeRelationCard(source, cfg.ownerIds, facts),
        )
      }
    }
    return next()
  })

  ctx.on('tools/pre-execute', (payload, next) => {
    const veto = vetoIfActive(payload.name, sandbox.isActive(), allowedForTurn(sandbox.currentSource()))
    return veto === undefined ? next() : Promise.resolve({ veto })
  })

  ctx.on('agent/inbox/claimed', (payload) => {
    const activated = sandbox.markClaimed([payload.message])
    if (activated !== undefined) {
      activeSessionId = payload.agent.session.id
      turnCardFacts = undefined
      ctx.emit('onebot/turn-scope', scopeEvent(activated))
    }
  })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (activeSessionId !== undefined && session.id !== activeSessionId) return
    sandbox.markTurnEnd()
    activeSessionId = undefined
    turnCardFacts = undefined
    ctx.emit('onebot/turn-scope', scopeEvent(undefined))
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

  // 语音出话：mode=off 时完全不接线（工具不暴露语音分支）；
  // 合成走壳层 TTS（Rust RPC，全局 TTS 总开关/凭据在壳层判定）。
  const voiceLastAt = new Map<string, number>()
  const voice: VoiceSendDeps | undefined = cfg.voice.mode === 'off'
    ? undefined
    : {
        policy: cfg.voice,
        synth: async (text: string) => {
          const data = await withTimeout(
            nativeRpc<{ base64?: string }>(
              'tts::synthesize',
              { text, ...(cfg.voice.name !== '' ? { voice: cfg.voice.name } : {}) },
              { label: 'tts::synthesize' },
            ),
            cfg.voice.timeoutMs,
            'TTS 合成超时',
          )
          if (typeof data?.base64 !== 'string' || data.base64 === '') {
            throw new Error('TTS 返回空音频')
          }
          return { base64: data.base64 }
        },
        cooldownOk: (key, now) =>
          voiceCooldownOk(voiceLastAt.get(key), now, cfg.voice.cooldownMinutes),
        noteUsed: (key, now) => {
          voiceLastAt.set(key, now)
        },
      }

  applyTools(ctx, {
    client,
    cfg,
    voice,
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

  // 启动全量压缩（群/私聊缓冲各留最近 2000 行；运行期由追加计数滚动截断）+ 建连
  trimAllBuffers()
  client.start()
  console.log(
    `[onebot] 就绪 ${cfg.wsUrl}（群：${cfg.groups.length > 0 ? cfg.groups.join(',') : '未配置'}；` +
    `上下文 ${cfg.context.maxMessages} 条/${cfg.context.maxAgeMinutes} 分钟；` +
    `插话概率 ${cfg.rate.plain}）`,
  )
}
