// @diver/memory — “她是不是一个人在”门控。
//
// 平台抓取只在 presence 处于 passive/observing/receptive、无输入、非 DND/专注/睡眠，
// 且距上次对话 ≥ idleMinutes 时发生。拿不到 snapshot 时 fail-closed。

import { nativeRpc } from '@diver/native-bridge/rpc'

export interface PresenceSnapshotLike {
  enabled?: boolean
  phase_name?: string
  regime?: string
  user_input_active?: boolean
  proactive?: { last_chat_at?: number }
}

const ALLOWED_PHASES = new Set(['passive', 'observing', 'receptive'])
const BLOCKED_REGIMES = new Set(['dnd', 'quiet_hours', 'focus', 'sleep'])

/** 纯判定：当前是否适合“一个人去逛逛”。 */
export function isIdleAlone(
  snapshot: PresenceSnapshotLike | null,
  opts: { now: number; idleMinutes: number; gateEnabled: boolean },
): boolean {
  if (!opts.gateEnabled) return true
  if (snapshot === null) return false
  if (snapshot.enabled === false) return false
  if (snapshot.user_input_active === true) return false
  if (!ALLOWED_PHASES.has(snapshot.phase_name ?? '')) return false
  if (BLOCKED_REGIMES.has(snapshot.regime ?? '')) return false
  const lastChat = snapshot.proactive?.last_chat_at ?? 0
  if (lastChat > 0 && opts.now - lastChat < opts.idleMinutes * 60_000) return false
  return true
}

/** 读壳端 presence 快照；失败返回 null（调用方按 fail-closed 处理）。 */
export async function readPresenceSnapshot(): Promise<PresenceSnapshotLike | null> {
  try {
    return await nativeRpc<PresenceSnapshotLike>('presence::snapshot', {}, { label: 'presence:snapshot' })
  } catch (err) {
    console.warn(`[platform] presence 快照不可用: ${(err as Error)?.message ?? err}`)
    return null
  }
}
