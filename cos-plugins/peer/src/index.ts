// @diver/peer —— 互实例消息工具（P2-2）。
//
// send_to_peer：把消息发给同一壳下的另一个实例。走 native-bridge → 壳
// services/peer 消息路由（发送方由壳按 X-Diver-Instance 身份头盖章，不可伪）
// → POST 对端 /api/inbox 注入其 session inbox，对端 agent 下一轮把消息当输入。
import type { Context } from 'cordis'
// 空类型导入：加载 @cos/plugin-api 对 cordis Context 的服务增强（tools 等）。
import type {} from '@cos/plugin-api'
import { nativeRpc } from '@diver/native-bridge/rpc'

/** cordis 注入声明：工具注册台（裸函数插件会丢注入，必须显式声明）。 */
export const inject = ['tools']

interface PeerSendResult {
  messageId?: string
  to?: string
  queued?: string
}

export function apply(ctx: Context) {
  ctx.tools.register('send_to_peer', async (args: unknown) => {
    const a = (args ?? {}) as { to?: unknown; text?: unknown; target?: unknown }
    const to = String(a.to ?? '').trim()
    const text = String(a.text ?? '').trim()
    if (!to || !text) {
      return { content: JSON.stringify({ error: 'to 与 text 必填' }) }
    }
    const target = a.target === 'next-step' ? 'next-step' : 'next-turn'
    try {
      const data = await nativeRpc<PeerSendResult>('peer::send', { to, text, target }, { label: 'send_to_peer' })
      return {
        content: JSON.stringify({
          sent: true,
          to,
          messageId: data.messageId ?? '',
          queued: data.queued ?? target,
        }),
      }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '给同一应用下的另一个实例发消息（实例间私聊）。消息注入对方会话，对方会当作输入回复；' +
      '收到的消息带有「消息来自实例 X（id）」标记，回复时把对方 id 作为 to。',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '目标实例 id（如 beta）；id 不对时错误里会列出可用实例' },
        text: { type: 'string', description: '消息内容' },
        target: {
          type: 'string',
          description:
            "投递时机：'next-turn'（对方下一轮，缺省）/'next-step'（对方当前轮步间插话）/'inject'（只入对方上下文，不打扰对方）",
        },
      },
      required: ['to', 'text'],
    },
  })

  ctx.tools.register('send_to_group', async (args: unknown) => {
    const a = (args ?? {}) as { text?: unknown; wake?: unknown }
    const text = String(a.text ?? '').trim()
    if (!text) return { content: JSON.stringify({ error: 'text 必填' }) }
    const wake = a.wake === true
    try {
      const data = await nativeRpc<{ delivered: unknown[]; failed: unknown[]; queued: string }>(
        'peer::broadcast',
        { text, wake },
        { label: 'send_to_group' },
      )
      return { content: JSON.stringify({ sent: true, ...data }) }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '在群聊里向其它所有实例发言（广播，不发给自己）。缺省只入对方上下文、不唤醒（对方不必回复）；' +
      'wake=true 才唤醒对方给发言机会。群聊规则：不必每条都回，想说才说；被 @ 点名时再认真接话。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '发言内容' },
        wake: { type: 'boolean', description: '是否唤醒对方给发言机会（缺省 false = 只入上下文不打扰）' },
      },
      required: ['text'],
    },
  })

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
      '选择不发言：收到消息（群聊或私聊）但没有想说的时候调用。不必每条都回——调用后直接结束回合，不产生回复。' +
      'reason 会记入可追溯记录（活动面板/会话日志），建议填沉默原因。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '选择沉默的原因（留痕可追溯，可不填）' },
      },
    },
  })
  console.log('[peer] 互实例消息工具就绪（send_to_peer / send_to_group / stay_silent）')
}
