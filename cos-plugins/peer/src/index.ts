// @diver/peer —— 互实例消息工具（P2-2）。
//
// send_to_peer：把消息发给同一壳下的另一个实例。走 native-bridge → 壳
// services/peer 消息路由（发送方由壳按 X-Diver-Instance 身份头盖章，不可伪）
// → POST 对端 /api/inbox 注入其 session inbox，对端 agent 下一轮把消息当输入。
import type { Context } from '@cos/plugin-api'
import { nativeRpc } from '@diver/native-bridge/rpc'

/** cordis 注入声明：工具注册台（裸函数插件会丢注入，必须显式声明）。 */
export const inject = ['tools']

interface PeerSendResult {
  messageId?: string
  to?: string
  queued?: string
}

export function apply(ctx: Context) {
  ctx.tools.register('send_to_peer', async (args) => {
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
          description: "投递时机：'next-turn'（对方下一轮，缺省）或 'next-step'（对方当前轮步间插话）",
        },
      },
      required: ['to', 'text'],
    },
  })
  console.log('[peer] 互实例消息工具就绪（send_to_peer → 壳消息路由）')
}
