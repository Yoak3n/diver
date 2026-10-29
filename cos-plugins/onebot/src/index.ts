// @diver/onebot — OneBot 11 接入（潜水 / @必回 / 偶尔插话）。
//
// 装配层：客户端生命周期、安全钩子（回合收权双闸）、工具与提示词挂载。
// 业务规则在纯函数模块（protocol/trigger/context/sandbox/mask），入站路由在
// router.ts。
//
// 接入：bundle insert `{ id: onebot, name: '@diver/onebot' }`；配置见 config.ts。

import type { Context } from 'cordis'
import { join } from 'node:path'

import { nativeRpc } from '@diver/native-bridge/rpc'

import { configDecl, ownerGate, resolveConfig, type Config } from './config.ts'
import { trimAllBuffers } from './buffer-store.ts'
import { createFsScope } from './fs-scope.ts'
import { applyNotesTool } from './notes-tool.ts'
import {
  TurnSandbox,
  allowedToolNames,
  canSteerInto,
} from './sandbox.ts'
import { applyTurnGate } from './turn-gate.ts'
import { OnebotClient } from './ws.ts'
import { OnebotStatusService } from './status.ts'
import { applyTools } from './tools.ts'
import type { VoiceSendDeps } from './outbox.ts'
import { createSelfRecorder } from './self-ledger.ts'
import { applyPrompt } from './prompt.ts'
import type { ShallowCardFacts } from './relation-card.ts'
import { createRouter, type CompanionLike } from './router.ts'
import { voiceCooldownOk } from './voice.ts'
import { RecentImages, imagesInContent } from './out-image.ts'

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
  const cfg = resolveConfig(config)
  // 运行时连接状态（设置「QQ 接入」页状态灯）：先注册，休眠分支也能说明原因。
  const status = new OnebotStatusService(ctx, cfg.wsUrl)
  // 归属闸门（先于 wsUrl 判定）：壳层绑定了 QQ 归属实例时，非归属实例一律休眠，
  // 多实例配同一 wsUrl 也不会出现双回复；未绑定保持旧「配置即归属」行为。
  // （变量名避开下方登录账号 selfId——那是 OneBot 侧 QQ 号，与本实例 id 无关。）
  const onebotOwner = (process.env.DIVER_ONEBOT_OWNER ?? '').trim()
  const myInstanceId = (process.env.DIVER_INSTANCE_ID ?? '').trim()
  if (!ownerGate(onebotOwner, myInstanceId)) {
    status.sleep(`QQ 已绑定实例 ${onebotOwner}，本实例休眠`)
    console.log(`[onebot] QQ 已绑定实例 ${onebotOwner}（本实例 ${myInstanceId || '?'}），插件休眠`)
    return
  }
  if (cfg.wsUrl === '') {
    status.sleep('未配置 wsUrl')
    console.log('[onebot] 未配置 wsUrl，插件休眠（设置「OneBot 11」后重启 sidecar 生效）')
    return
  }
  const companionRaw = (ctx as Context & { companion?: CompanionLike }).companion
  if (companionRaw === undefined) {
    status.sleep('伴聊服务（ctx.companion）不可用')
    console.warn('[onebot] ctx.companion 不可用（backend 未挂载？），插件休眠')
    return
  }
  const companion = companionRaw

  const sandbox = new TurnSandbox()
  const allowed = allowedToolNames(cfg.sandbox.allowedTools)
  let selfId = 0
  /** 登录昵称（自己发言落账署名；未取到前兜底「我」）。 */
  let selfName = ''
  /** 身份卡片原始 IO；按回合缓存由 turn-gate 负责。 */
  const loadCardFacts = (): Promise<ShallowCardFacts> =>
    withTimeout(
      nativeRpc<{ name?: string | null }>('get_card', {}, { label: 'memory:get_card' }),
      1_500,
      '读取身份卡片超时',
    )
      .then((card) => ({ name: card?.name ?? '' }))
      .catch(() => ({ name: '' }))

  // 文件作用域：COS_HOME 缺省回退与 basic-tools 同约定；笔记根在基线里整棵拒绝，
  // 只对当前来源自己的 scope 开例外（策略按 scope 缓存在 fs-scope.ts）。
  const fsScope = createFsScope({
    cosHome: process.env.COS_HOME ?? join(process.cwd(), '.cos-home'),
    extraRoots: cfg.sandbox.fsExtraRoots,
  })

  // 回合级笔记预算：新回合激活 / turn/end 时重置，同一回合的多次 steer 不重置。
  const noteBudget = { appends: 0, bytes: 0 }
  const resetNoteBudget = (): void => {
    noteBudget.appends = 0
    noteBudget.bytes = 0
  }

  // 近期图片缓存：会话里真人发来的图（QQ 收到的 / 桌面端附件）统一喂入，
  // 出话工具用句柄引用转发。subagent/注入消息不进（只认 kind=human）。
  const recentImages = new RecentImages()
  ctx.on('session/event', (_session, event) => {
    if (event.type !== 'user/message' || event.data?.source?.kind !== 'human') return
    const from = typeof event.data.source?.detail === 'string' && event.data.source.detail !== ''
      ? event.data.source.detail
      : 'desktop'
    for (const img of imagesInContent(event.data.content)) recentImages.add(img, from)
  })

  // ---- 客户端 + 入站路由 + 出话工具 ----

  const client = new OnebotClient({
    url: cfg.wsUrl,
    token: cfg.token,
    onGroupMessage: (event) => void router.handleGroup(event),
    onPrivateMessage: (event) => void router.handlePrivate(event),
    onStatus: (event) => {
      if (event.status === 'connecting') {
        status.connecting()
        return
      }
      if (event.status === 'disconnected') {
        const reason = event.reason !== undefined && event.reason !== ''
          ? event.reason
          : event.code !== undefined
            ? `连接已关闭（code ${event.code}）`
            : '连接已断开'
        status.offline(reason, event.retryMs)
        return
      }
      // WS open 只代表握手成功：认证失败的服务端会 open 后立刻 close，
      // 拿到 get_login_info 才算真正 online（状态灯据此亮绿）。
      status.connecting()
      client.call<{ user_id?: number; nickname?: string }>('get_login_info', {}, 5000)
        .then((data) => {
          const id = Number(data?.user_id ?? 0)
          if (id > 0) selfId = id
          const nick = typeof data?.nickname === 'string' ? data.nickname.trim() : ''
          if (nick !== '') selfName = nick
          if (selfId > 0) console.log(`[onebot] 登录账号 ${selfId}${selfName !== '' ? `（${selfName}）` : ''}`)
          status.online(selfId, selfName)
          client.markHealthy()
        })
        .catch((error: unknown) => {
          // 拿不到不阻断入站（回声过滤用事件自带 self_id）；只在状态灯留下原因。
          status.loginFailed(error instanceof Error ? error.message : String(error))
        })
    },
  })

  // 忙时插话只允许同来源域：跨来源合批会借用先到来源的工具面与记忆命名空间。
  const router = createRouter({
    companion,
    cfg,
    client,
    canSteer: (source) => canSteerInto(source, sandbox.currentSource(), cfg.ownerIds),
  })

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
    images: recentImages,
    // image 参数本地路径的囚笼：与 read/ls/find/grep 同一策略——按当前回合来源
    // 现算（主人私聊不受限；群/私聊只开自己的笔记 scope；桌面回合走基线档）。
    imageFs: async () => ({
      policy: await fsScope.policyFor(sandbox.currentSource(), cfg.ownerIds),
      workspaceBase: await fsScope.workspaceBase(),
    }),
    voice,
    anchor: router.anchor,
    rememberSent: router.rememberSent,
    onSpoke: router.noteSpoke,
    // 自己发言记账：出站即进会话缓冲（背景窗时间线）+ 群发落 group-sent.jsonl
    recordSend: createSelfRecorder({
      selfIdentity: () => ({ id: selfId, name: selfName !== '' ? selfName : '我' }),
      groupNameOf: router.groupName,
    }),
  })

  // 笔记追加（唯一写入口）：按当前回合来源选作用域，写不了就报错。
  applyNotesTool(ctx, {
    sandbox,
    ownerIds: cfg.ownerIds,
    notesRoot: () => fsScope.notesRoot(),
    budget: noteBudget,
  })

  // 回合闸门：可见性/执行/路径囚笼/来源广播/收入结算。
  applyTurnGate(ctx, {
    sandbox,
    ownerIds: cfg.ownerIds,
    allowed,
    fs: fsScope,
    loadCardFacts,
    resetNoteBudget,
    onMainTurnEnd: router.settleTurn,
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
