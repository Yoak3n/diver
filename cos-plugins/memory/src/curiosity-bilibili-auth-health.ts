// @diver/memory — 登录态后台体检：自动续期 → nav 校验 → 失效通知 → 匿名回退。
//
// 续期用 passport 官方 Web 刷新链路；体检每个平台会话最多一次，续期检查 24h 节流。
// 失效时白天（09–23）最多 24h 通知一次，避免后台反复弹窗。

import { nativeRpc } from '@diver/native-bridge/rpc'

import {
  fetchLoginProfile,
  readBilibiliAuth,
  writeBilibiliAuth,
  type BilibiliAuth,
} from './curiosity-bilibili-auth.ts'
import { refreshBilibiliAuth } from './curiosity-bilibili-refresh.ts'

export type NotifyFn = (title: string, body: string) => Promise<void>

export interface EnsureAuthOptions {
  now?: number
  fetchProfile?: typeof fetchLoginProfile
  notify?: NotifyFn
  refresh?: typeof refreshBilibiliAuth
}

const REFRESH_CHECK_MS = 24 * 3600_000
const REFRESH_AHEAD_MS = 7 * 24 * 3600_000

/** 有效返回 auth；失效标记 + 通知 + 返回 null；网络失败乐观返回旧 auth。 */
export async function ensureBilibiliAuth(
  home: string,
  opts: EnsureAuthOptions = {},
): Promise<BilibiliAuth | null> {
  const loaded = readBilibiliAuth(home)
  if (loaded === null) return null
  const now = opts.now ?? Date.now()
  if (loaded.invalidAt !== undefined && now - loaded.invalidAt < 60 * 60_000) return null

  let current = loaded
  const tokensReady = current.biliJct !== undefined && current.refreshToken !== undefined
  const sinceCheck = current.lastRefreshCheckAt === undefined
    ? Number.POSITIVE_INFINITY
    : now - current.lastRefreshCheckAt
  const expiresSoon = current.expiresAt !== undefined && now >= current.expiresAt - REFRESH_AHEAD_MS
  if (tokensReady && (sinceCheck >= REFRESH_CHECK_MS || expiresSoon)) {
    try {
      const outcome = await (opts.refresh ?? refreshBilibiliAuth)(current, { now })
      if (outcome.status === 'refreshed' || outcome.status === 'not-needed') {
        if (outcome.status === 'refreshed') console.log('[bilibili] 登录 cookie 已自动续期')
        current = { ...outcome.auth, lastRefreshCheckAt: now }
        writeBilibiliAuth(home, current)
      } else if (outcome.status === 'invalid') {
        await markBilibiliAuthInvalid(home, current, now, opts)
        return null
      } else {
        console.warn(`[bilibili] 续期失败（网络/未知），继续用旧凭据: ${outcome.message}`)
      }
    } catch (err) {
      console.warn(`[bilibili] 续期异常: ${(err as Error)?.message ?? err}`)
    }
  }

  if (current.expiresAt !== undefined && now > current.expiresAt) {
    await markBilibiliAuthInvalid(home, current, now, opts)
    return null
  }

  const profile = await (opts.fetchProfile ?? fetchLoginProfile)(current)
  if (profile.loggedIn) {
    const next: BilibiliAuth = {
      ...current,
      ...(profile.name === undefined ? {} : { name: profile.name }),
      ...(profile.mid === undefined ? {} : { mid: profile.mid }),
    }
    delete next.invalidAt
    delete next.notifiedAt
    if (JSON.stringify(next) !== JSON.stringify(current)) writeBilibiliAuth(home, next)
    return next
  }
  if (profile.expired === true) {
    await markBilibiliAuthInvalid(home, current, now, opts)
    return null
  }
  return current
}

/** 标记失效；白天（09–23）最多 24h 通知一次。 */
export async function markBilibiliAuthInvalid(
  home: string,
  auth: BilibiliAuth,
  now = Date.now(),
  opts: { notify?: NotifyFn } = {},
): Promise<void> {
  let notifiedAt = auth.notifiedAt
  const shouldNotify = notifiedAt === undefined || now - notifiedAt >= 24 * 3600_000
  if (shouldNotify && isDaytime(now)) {
    try {
      await (opts.notify ?? defaultNotify)(
        'B 站登录已失效',
        '自动续期未成功，Diver 已退回匿名观察。需要更完整的评论/字幕，请到设置 → 状态机 → 好奇心清单重新扫码。',
      )
      notifiedAt = now
    } catch (err) {
      console.warn(`[bilibili] 失效通知发送失败: ${(err as Error)?.message ?? err}`)
    }
  }
  writeBilibiliAuth(home, {
    ...auth,
    invalidAt: now,
    ...(notifiedAt === undefined ? {} : { notifiedAt }),
  })
}

export function isDaytime(now: number): boolean {
  const hour = new Date(now).getHours()
  return hour >= 9 && hour < 23
}

const defaultNotify: NotifyFn = async (title, body) => {
  await nativeRpc('notify::show', { title, body }, { label: 'notify:show' })
}
