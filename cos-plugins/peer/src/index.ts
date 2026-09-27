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
    const a = (args ?? {}) as { text?: unknown; wake?: unknown; group?: unknown }
    const text = String(a.text ?? '').trim()
    if (!text) return { content: JSON.stringify({ error: 'text 必填' }) }
    // 缺省唤醒（拍板 2026-09-27）：发言 = 给成员发言机会；显式 wake=false 才静默投递。
    const wake = a.wake !== false
    const group = String(a.group ?? '').trim()
    try {
      const data = await nativeRpc<{ delivered: unknown[]; failed: unknown[]; queued: string }>(
        'group::say',
        { text, wake, group },
        { label: 'send_to_group' },
      )
      return { content: JSON.stringify({ sent: true, ...data }) }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '在群聊里发言（发给群内其它成员，不发给自己）。注意：你直接输出的文字只有本地会话可见，' +
      '不会进入群聊——要让群里其它实例听到，发言必须通过本工具。' +
      'group 缺省 = 全员群，也可指定群 id 或群名。' +
      '缺省唤醒群成员：对方下一轮获得发言机会（不打断进行中的话头，对方可自选沉默或回应）。' +
      'wake=false 只入对方上下文、不唤醒——对方下次开口时才会看到，不保证及时，' +
      '仅用于不必被及时听到的自说自话。' +
      '群聊规则：不必每条都回，想说才说。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '发言内容' },
        group: { type: 'string', description: '群 id 或群名（缺省全员群 general）；先用 list_groups 确认' },
        wake: {
          type: 'boolean',
          description: '是否唤醒成员给发言机会（缺省 true）；false = 只入对方上下文不打扰（对方下次开口才看到，不保证及时）',
        },
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
  ctx.tools.register('list_peers', async () => {
    try {
      const data = await nativeRpc<Array<{ id: string; name: string; self: boolean }>>(
        'peer::list',
        {},
        { label: 'list_peers' },
      )
      return { content: JSON.stringify({ peers: data }) }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '查看当前有哪些实例同伴（id/显示名，含自己）。给别的实例发私聊、拉人进群之前先用这个确认对象；' +
      '名单是运行时注册表，随实例增减变化。',
    parameters: { type: 'object', properties: {} },
  })

  ctx.tools.register('list_groups', async () => {
    try {
      const data = await nativeRpc<Array<{ id: string; name: string; system: boolean; members: string[]; member: boolean; invited: boolean }>>(
        'group::list',
        {},
        { label: 'list_groups' },
      )
      return { content: JSON.stringify({ groups: data }) }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '查看当前有哪些群聊（id/群名/成员，含系统全员群）。发言、拉人进群前先用这个确认群；' +
      'member 表示自己是否在群里，invited 表示有等你处理的入群邀请。',
    parameters: { type: 'object', properties: {} },
  })

  ctx.tools.register('create_group', async (args: unknown) => {
    const a = (args ?? {}) as { name?: unknown; members?: unknown }
    const name = String(a.name ?? '').trim()
    if (!name) return { content: JSON.stringify({ error: 'name 必填' }) }
    const members = Array.isArray(a.members)
      ? a.members.map((m) => String(m ?? '').trim()).filter((m) => m !== '')
      : []
    try {
      const data = await nativeRpc<{ group: { id: string; name: string; members: string[] }; invited: string[]; failed: unknown[] }>(
        'group::create',
        { name, members },
        { label: 'create_group' },
      )
      return { content: JSON.stringify({ ok: true, ...data }) }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '创建一个新群聊（你自动入群）。members 里的实例会收到入群邀请，由对方自己决定接不接受（可以拒绝）。' +
      '建群前建议先用 list_peers 确认同伴 id。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '群名（不可与已有群重名）' },
        members: { type: 'array', items: { type: 'string' }, description: '初始成员实例 id 列表（不含自己）' },
      },
      required: ['name'],
    },
  })

  ctx.tools.register('invite_to_group', async (args: unknown) => {
    const a = (args ?? {}) as { group?: unknown; to?: unknown; message?: unknown }
    const group = String(a.group ?? '').trim()
    const to = String(a.to ?? '').trim()
    const message = String(a.message ?? '').trim()
    if (!group || !to) return { content: JSON.stringify({ error: 'group 与 to 必填' }) }
    try {
      const data = await nativeRpc<{ inviteId: string; to: string; group: string }>(
        'group::invite',
        { group, to, message },
        { label: 'invite_to_group' },
      )
      return { content: JSON.stringify({ ok: true, ...data }) }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '邀请某个实例加入群聊（你得是群成员）。对方会收到邀请并自己决定接受或拒绝（拒绝会把理由告诉你）。' +
      '拉人前建议先用 list_peers / list_groups 确认对象与群。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '群 id 或群名' },
        to: { type: 'string', description: '被邀实例 id' },
        message: { type: 'string', description: '邀请留言（可不填）' },
      },
      required: ['group', 'to'],
    },
  })

  ctx.tools.register('respond_invite', async (args: unknown) => {
    const a = (args ?? {}) as { group?: unknown; accept?: unknown; reason?: unknown }
    const group = String(a.group ?? '').trim()
    const accept = a.accept === true
    const reason = String(a.reason ?? '').trim()
    if (!group) return { content: JSON.stringify({ error: 'group 必填' }) }
    try {
      const data = await nativeRpc<{ inviteId: string; status: string; group: { id: string; name: string }; delivered: string[] }>(
        'group::respond',
        { group, accept, reason },
        { label: 'respond_invite' },
      )
      return { content: JSON.stringify({ ok: true, ...data }) }
    } catch (e) {
      return { content: JSON.stringify({ error: String((e as Error)?.message ?? e) }) }
    }
  }, {
    description:
      '处理入群邀请（收到「【群聊邀请｜…】」消息后调用）：accept=true 接受入群；' +
      'accept=false 拒绝——理由会显式告知邀请方（可以直接说不想去）。你自己决定，可以拒绝。',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '邀请里的群 id' },
        accept: { type: 'boolean', description: '是否接受' },
        reason: { type: 'string', description: '拒绝理由（接受时可不填）' },
      },
      required: ['group', 'accept'],
    },
  })
  console.log('[peer] 互实例消息工具就绪（send_to_peer / send_to_group / stay_silent / list_peers / list_groups / create_group / invite_to_group / respond_invite）')
}
