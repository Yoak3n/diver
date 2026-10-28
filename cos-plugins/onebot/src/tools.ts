// @diver/onebot — 出话工具（send_qq_group / send_qq_private / stay_silent）。
//
// 工具是发往 QQ 的唯一出口：出站文本在此过遮蔽总闸，发送经 outbox.ts 的串行
// 队列 + 间隔节流（QQ 风控优先于拟人化）。群回复缺省引用触发消息（5 分钟内），
// 群友知道在答谁——模型不碰协议细节。

import type { Context } from 'cordis'
import type {} from '@cos/plugin-api'

import type { ResolvedConfig } from './config.ts'
import { maskOutbound } from './mask.ts'
import { voiceKey } from './voice.ts'
import { SendQueue, settleMessage, type VoiceSendDeps } from './outbox.ts'
import { resolveImageArg, type ImageOutcome, type RecentImages } from './out-image.ts'
import type { SelfSendInput } from './self-ledger.ts'
import type { FsPolicy } from './fs-jail.ts'
import type { OnebotClient } from './ws.ts'

export interface TriggerAnchor {
  groupId: string
  messageId: number
  /** 毫秒。 */
  at: number
}

export interface SendDeps {
  client: OnebotClient
  cfg: ResolvedConfig
  /** 近期图片句柄缓存（出站 image 参数引用）。 */
  images: RecentImages
  /** image 参数本地路径的囚笼（按当前回合来源现算；与 read 等只读工具同界）。 */
  imageFs: () => Promise<{ policy: FsPolicy; workspaceBase: string }>
  /** 语音出话（mode=off 时为 undefined：工具不暴露语音分支）。 */
  voice?: VoiceSendDeps
  /** 近期群触发锚点（无参 = 最近任一；有参 = 该群）。 */
  anchor(groupId?: string): TriggerAnchor | undefined
  /** 我发出的消息 id（引用回复检测）。 */
  rememberSent(groupId: string, messageId: number): void
  /** 本回合实际发言（沉默退避记账）。 */
  onSpoke(): void
  /** 自己发言记账：进会话缓冲（背景窗时间线）+ 群发落 group-sent.jsonl。 */
  recordSend(send: SelfSendInput): Promise<void>
}

/** 引用锚定有效期：超过则发裸消息（避免答非所问）。 */
const QUOTE_MAX_AGE_MS = 5 * 60_000

export function applyTools(ctx: Context, deps: SendDeps): void {
  const queue = new SendQueue(deps.cfg.sendIntervalMs)

  const voiceFlag = (raw: unknown): boolean | undefined =>
    raw === true ? true : raw === false ? false : undefined

  /** image 参数三态解析（清单/错误本地短路，不占发送配额；直链/本地路径含取回 IO）。 */
  const resolveImage = async (raw: unknown): Promise<ImageOutcome> =>
    resolveImageArg(raw, { images: deps.images, imageFs: deps.imageFs })

  ctx.tools.register('send_qq_group', async (args: unknown) => {
    const a = (args ?? {}) as { text?: unknown; group?: unknown; voice?: unknown; image?: unknown }
    const image = await resolveImage(a.image)
    if (image.kind === 'reply') return { content: image.content }
    const text = String(a.text ?? '').trim()
    if (text === '' && image.kind !== 'segment') return { content: JSON.stringify({ error: 'text 必填（或提供 image）' }) }
    const groupArg = String(a.group ?? '').trim()
    const anchor = deps.anchor(groupArg !== '' ? groupArg : undefined)
    const groupId = groupArg !== '' ? groupArg : anchor?.groupId
    if (groupId === undefined || groupId === '') {
      return { content: JSON.stringify({ error: 'group 必填（未发现可用的近期群聊来源）' }) }
    }
    const blocked = queue.blockedJson()
    if (blocked !== undefined) return blocked
    const quoteId =
      anchor !== undefined
      && anchor.groupId === groupId
      && anchor.messageId !== 0
      && Date.now() - anchor.at <= QUOTE_MAX_AGE_MS
        ? anchor.messageId
        : undefined
    const masked = maskOutbound(text, deps.cfg.privacy)
    const { segments, voiceInfo } = await settleMessage(
      masked.text,
      // 纯图无文字时跳过语音（空文本合成无意义，图照发）
      (text === '' && image.kind === 'segment' ? false : voiceFlag(a.voice)),
      voiceKey('group', groupId),
      deps.voice,
      quoteId,
    )
    if (image.kind === 'segment') segments.push(image.segment)
    try {
      const data = await queue.run(() =>
        deps.client.call<{ message_id?: number }>('send_group_msg', {
          group_id: Number(groupId),
          message: segments,
        }),
      )
      const messageId = Number(data?.message_id ?? 0)
      queue.recordOk()
      if (messageId !== 0) deps.rememberSent(groupId, messageId)
      deps.onSpoke()
      await deps.recordSend({
        kind: 'group',
        peerId: groupId,
        text: masked.text,
        voice: voiceInfo?.voice === true,
        hasImage: image.kind === 'segment',
        messageId,
      })
      return {
        content: JSON.stringify({
          sent: true,
          group: groupId,
          ...(messageId !== 0 ? { messageId } : {}),
          ...(masked.masked.length > 0 ? { masked: masked.masked } : {}),
          ...(image.kind === 'segment' ? { image: image.info } : {}),
          ...(voiceInfo ?? {}),
        }),
      }
    } catch (error) {
      return queue.failJson(error)
    }
  }, {
    description:
      '在 QQ 群里发言（缺省引用触发消息；group 缺省 = 最近一次唤醒你的群）。' +
      '你直接输出的文字只有本地桌面可见，不会进 QQ——在群里说话必须调用本工具。' +
      '被 @ 时必须回应；闲聊不必每条都回。出站会自动遮蔽本地路径/凭据/联系方式，' +
      '返回里的 masked 是遮蔽统计，不要尝试绕过。' +
      '图片：image 参数可传近期图片句柄（image="list" 查看可用清单；会话里收到过的图都在）、' +
      'http(s) 直链（本机取回后发出）或囚笼内本地图片路径（相对路径按 workspace 根解析，与 read 同界）；' +
      '只发图不配文字也可以。' +
      '语音：仅当确实适合时才传 voice=true（默认未开启语音，此时会自动改发文本）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '发言内容（会被隐私遮蔽后发出；只发图可留空）' },
        group: { type: 'string', description: '群号（可选；缺省 = 最近唤醒你的群）' },
        image: { type: 'string', description: '随消息附图：近期图片句柄（"list" 列出可用）、http(s) 直链或本地图片路径（相对路径按 workspace 根解析；可选）' },
        voice: { type: 'boolean', description: '是否用语音发送（可选；语音与文字二选一，不要重复发）' },
      },
      required: [],
    },
  })

  ctx.tools.register('send_qq_private', async (args: unknown) => {
    const a = (args ?? {}) as { text?: unknown; user?: unknown; voice?: unknown; image?: unknown }
    const image = await resolveImage(a.image)
    if (image.kind === 'reply') return { content: image.content }
    const text = String(a.text ?? '').trim()
    if (text === '' && image.kind !== 'segment') return { content: JSON.stringify({ error: 'text 必填（或提供 image）' }) }
    const user = String(a.user ?? '').trim()
    if (user === '') return { content: JSON.stringify({ error: 'user 必填（QQ 号）' }) }
    const blocked = queue.blockedJson()
    if (blocked !== undefined) return blocked
    const masked = maskOutbound(text, deps.cfg.privacy)
    const { segments, voiceInfo } = await settleMessage(
      masked.text,
      // 纯图无文字时跳过语音（空文本合成无意义，图照发）
      (text === '' && image.kind === 'segment' ? false : voiceFlag(a.voice)),
      voiceKey('private', user),
      deps.voice,
    )
    if (image.kind === 'segment') segments.push(image.segment)
    try {
      const data = await queue.run(() =>
        deps.client.call<{ message_id?: number }>('send_private_msg', {
          user_id: Number(user),
          message: segments,
        }),
      )
      const messageId = Number(data?.message_id ?? 0)
      queue.recordOk()
      deps.onSpoke()
      await deps.recordSend({
        kind: 'private',
        peerId: user,
        text: masked.text,
        voice: voiceInfo?.voice === true,
        hasImage: image.kind === 'segment',
        messageId,
      })
      return {
        content: JSON.stringify({
          sent: true,
          user,
          ...(messageId !== 0 ? { messageId } : {}),
          ...(masked.masked.length > 0 ? { masked: masked.masked } : {}),
          ...(image.kind === 'segment' ? { image: image.info } : {}),
          ...(voiceInfo ?? {}),
        }),
      }
    } catch (error) {
      return queue.failJson(error)
    }
  }, {
    description:
      '给 QQ 用户发私聊。私聊是直接对话，不必沉默；对方发来消息后优先回应。' +
      '你直接输出的文字只有本地桌面可见，私聊必须调用本工具。出站自动遮蔽隐私信息。' +
      '图片：image 参数可传近期图片句柄（image="list" 查看可用清单；会话里收到过的图都在）、' +
      'http(s) 直链（本机取回后发出）或囚笼内本地图片路径（相对路径按 workspace 根解析，与 read 同界）；' +
      '只发图不配文字也可以。' +
      '语音：私聊场景适合语音时可以传 voice=true（未配置语音时会自动改发文本）。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '私聊内容（会被隐私遮蔽后发出；只发图可留空）' },
        user: { type: 'string', description: '对方 QQ 号' },
        image: { type: 'string', description: '随消息附图：近期图片句柄（"list" 列出可用）、http(s) 直链或本地图片路径（相对路径按 workspace 根解析；可选）' },
        voice: { type: 'boolean', description: '是否用语音发送（可选；语音与文字二选一）' },
      },
      required: ['user'],
    },
  })

  // peer 插件已注册同名工具时沿用（语义一致）；单独加载时自有出口仍可用。
  if (ctx.tools.get('stay_silent') === undefined) {
    ctx.tools.register('stay_silent', async (args: unknown) => {
      const a = (args ?? {}) as { reason?: unknown }
      const reason = String(a.reason ?? '').trim()
      return {
        content: JSON.stringify({
          ok: true,
          silent: true,
          ...(reason !== '' ? { reason } : {}),
          note: '已记录：本轮选择不发言。请直接结束本回合，不要再输出任何文字内容。',
        }),
      }
    }, {
      description:
        '选择不发言：收到群聊消息但没有想说的时候调用。调用后直接结束回合，不产生回复。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '选择沉默的原因（留痕可追溯，可不填）' },
        },
      },
    })
  }

  console.log('[onebot] 出话工具就绪（send_qq_group / send_qq_private / stay_silent）')
}
