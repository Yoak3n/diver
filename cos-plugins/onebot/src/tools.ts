// @diver/onebot — 出话工具（send_qq_group / send_qq_private / stay_silent）。
//
// 工具是发往 QQ 的唯一出口：出站文本在此过遮蔽总闸，发送经串行队列 + 间隔
// 节流（QQ 风控优先于拟人化）。群回复缺省引用触发消息（5 分钟内），群友知道
// 在答谁——模型不碰协议细节。

import type { Context } from 'cordis'
import type {} from '@cos/plugin-api'

import type { ResolvedConfig } from './config.ts'
import { maskOutbound } from './mask.ts'
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
  /** 近期群触发锚点（无参 = 最近任一；有参 = 该群）。 */
  anchor(groupId?: string): TriggerAnchor | undefined
  /** 我发出的消息 id（引用回复检测）。 */
  rememberSent(groupId: string, messageId: number): void
  /** 本回合实际发言（沉默退避记账）。 */
  onSpoke(): void
}

/** 引用锚定有效期：超过则发裸消息（避免答非所问）。 */
const QUOTE_MAX_AGE_MS = 5 * 60_000

/** 出站消息段（数组形态；text 段为字面文本，无需 CQ 转义）。 */
function buildMessage(text: string, quoteId?: number): Array<{ type: string; data: Record<string, unknown> }> {
  const segments: Array<{ type: string; data: Record<string, unknown> }> = []
  if (quoteId !== undefined) segments.push({ type: 'reply', data: { id: String(quoteId) } })
  segments.push({ type: 'text', data: { text } })
  return segments
}

function errorJson(error: unknown): { content: string; isError: true } {
  const message = error instanceof Error ? error.message : String(error)
  return { content: JSON.stringify({ error: message }), isError: true }
}

export function applyTools(ctx: Context, deps: SendDeps): void {
  // 串行队列 + 最小间隔（同一实现侧连续发送易触发风控）
  let chain: Promise<unknown> = Promise.resolve()
  let lastSendAt = 0
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = deps.cfg.sendIntervalMs - (Date.now() - lastSendAt)
      if (lastSendAt > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      try {
        return await job()
      } finally {
        lastSendAt = Date.now()
      }
    })
    chain = run.catch(() => undefined)
    return run
  }

  ctx.tools.register('send_qq_group', async (args: unknown) => {
    const a = (args ?? {}) as { text?: unknown; group?: unknown }
    const text = String(a.text ?? '').trim()
    if (text === '') return { content: JSON.stringify({ error: 'text 必填' }) }
    const groupArg = String(a.group ?? '').trim()
    const anchor = deps.anchor(groupArg !== '' ? groupArg : undefined)
    const groupId = groupArg !== '' ? groupArg : anchor?.groupId
    if (groupId === undefined || groupId === '') {
      return { content: JSON.stringify({ error: 'group 必填（未发现可用的近期群聊来源）' }) }
    }
    const quoteId =
      anchor !== undefined
      && anchor.groupId === groupId
      && anchor.messageId > 0
      && Date.now() - anchor.at <= QUOTE_MAX_AGE_MS
        ? anchor.messageId
        : undefined
    const masked = maskOutbound(text, deps.cfg.privacy)
    try {
      const data = await enqueue(() =>
        deps.client.call<{ message_id?: number }>('send_group_msg', {
          group_id: Number(groupId),
          message: buildMessage(masked.text, quoteId),
        }),
      )
      const messageId = Number(data?.message_id ?? 0)
      if (messageId > 0) deps.rememberSent(groupId, messageId)
      deps.onSpoke()
      return {
        content: JSON.stringify({
          sent: true,
          group: groupId,
          ...(messageId > 0 ? { messageId } : {}),
          ...(masked.masked.length > 0 ? { masked: masked.masked } : {}),
        }),
      }
    } catch (error) {
      return errorJson(error)
    }
  }, {
    description:
      '在 QQ 群里发言（缺省引用触发消息；group 缺省 = 最近一次唤醒你的群）。' +
      '你直接输出的文字只有本地桌面可见，不会进 QQ——在群里说话必须调用本工具。' +
      '被 @ 时必须回应；闲聊不必每条都回。出站会自动遮蔽本地路径/凭据/联系方式，' +
      '返回里的 masked 是遮蔽统计，不要尝试绕过。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '发言内容（会被隐私遮蔽后发出）' },
        group: { type: 'string', description: '群号（可选；缺省 = 最近唤醒你的群）' },
      },
      required: ['text'],
    },
  })

  ctx.tools.register('send_qq_private', async (args: unknown) => {
    const a = (args ?? {}) as { text?: unknown; user?: unknown }
    const text = String(a.text ?? '').trim()
    const user = String(a.user ?? '').trim()
    if (text === '') return { content: JSON.stringify({ error: 'text 必填' }) }
    if (user === '') return { content: JSON.stringify({ error: 'user 必填（QQ 号）' }) }
    const masked = maskOutbound(text, deps.cfg.privacy)
    try {
      const data = await enqueue(() =>
        deps.client.call<{ message_id?: number }>('send_private_msg', {
          user_id: Number(user),
          message: buildMessage(masked.text),
        }),
      )
      const messageId = Number(data?.message_id ?? 0)
      deps.onSpoke()
      return {
        content: JSON.stringify({
          sent: true,
          user,
          ...(messageId > 0 ? { messageId } : {}),
          ...(masked.masked.length > 0 ? { masked: masked.masked } : {}),
        }),
      }
    } catch (error) {
      return errorJson(error)
    }
  }, {
    description:
      '给 QQ 用户发私聊。私聊是直接对话，不必沉默；对方发来消息后优先回应。' +
      '你直接输出的文字只有本地桌面可见，私聊必须调用本工具。出站自动遮蔽隐私信息。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '私聊内容（会被隐私遮蔽后发出）' },
        user: { type: 'string', description: '对方 QQ 号' },
      },
      required: ['text', 'user'],
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
