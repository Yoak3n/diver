// @diver/onebot — 私聊发送者昵称解析（事件昵称优先，OneBot API 兜底，按号码缓存）。
//
// NapCat 的私聊 message 事件 sender 经常没有 nickname/card（新加好友后的第一条
// 尤其明显），protocol.senderName 会退化成 QQ 号，来源章就成了「号码(号码)」。
// 这里先用事件自带的显示名；缺省或与号码相同时问实现侧（get_stranger_info，
// 好友列表兜底），仍解析不到才退回号码——解析失败只影响显示，不阻断回合。

import type { OnebotSender } from './protocol.ts'

/** 只用到的客户端能力（便于单测注入假实现）。 */
export interface NameClient {
  call<T = unknown>(action: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

/**
 * 事件自带的可用显示名；私聊优先昵称（群名片是群内身份），缺失或就是号码
 * 本身时返回 undefined。
 */
export function eventNameOf(sender: OnebotSender | undefined): string | undefined {
  if (sender === undefined) return undefined
  const id = String(sender.user_id)
  const nickname = typeof sender.nickname === 'string' ? sender.nickname.trim() : ''
  if (nickname !== '' && nickname !== id) return nickname
  const card = typeof sender.card === 'string' ? sender.card.trim() : ''
  if (card !== '' && card !== id) return card
  return undefined
}

/** 昵称查询超时：单个动作 3 秒；两个都超时就是 6 秒，代价只在首条消息。 */
const NAME_TIMEOUT_MS = 3000

async function resolveViaApi(client: NameClient, userId: string): Promise<string | undefined> {
  const id = Number(userId)
  if (!Number.isSafeInteger(id) || id <= 0) return undefined
  try {
    const info = await client.call<{ nickname?: unknown }>(
      'get_stranger_info',
      { user_id: id, no_cache: false },
      NAME_TIMEOUT_MS,
    )
    const nickname = typeof info?.nickname === 'string' ? info.nickname.trim() : ''
    if (nickname !== '' && nickname !== userId) return nickname
  } catch {
    // 实现侧不支持/超时：换好友列表
  }
  try {
    const list = await client.call<unknown>('get_friend_list', {}, NAME_TIMEOUT_MS)
    if (Array.isArray(list)) {
      const hit = (list as Array<Record<string, unknown>>).find(
        (item) => Number(item?.user_id) === id,
      )
      const nickname = typeof hit?.nickname === 'string' ? hit.nickname.trim() : ''
      if (nickname !== '' && nickname !== userId) return nickname
      const remark = typeof hit?.remark === 'string' ? hit.remark.trim() : ''
      if (remark !== '') return remark
    }
  } catch {
    // 解析不到就退回号码
  }
  return undefined
}

export type PrivateNameResolver = (userId: string, sender?: OnebotSender) => Promise<string>

export function createPrivateNameResolver(client: NameClient): PrivateNameResolver {
  const names = new Map<string, string>()
  /** 同一用户的并发解析合流，避免首条消息被拆成多次 API 调用。 */
  const inflight = new Map<string, Promise<string | undefined>>()

  const lookup = (userId: string): Promise<string | undefined> => {
    const pending = inflight.get(userId)
    if (pending !== undefined) return pending
    const started = resolveViaApi(client, userId).finally(() => inflight.delete(userId))
    inflight.set(userId, started)
    return started
  }

  return async (userId, sender) => {
    const fromEvent = eventNameOf(sender)
    if (fromEvent !== undefined) {
      names.set(userId, fromEvent)
      return fromEvent
    }
    const cached = names.get(userId)
    if (cached !== undefined) return cached
    const resolved = await lookup(userId)
    if (resolved !== undefined) {
      names.set(userId, resolved)
      return resolved
    }
    return userId
  }
}
