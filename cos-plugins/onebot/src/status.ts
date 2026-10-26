// @diver/onebot — 连接状态快照（设置「QQ 接入」页状态灯）。
//
// 纯记账层：ws.ts 上报连接事件，index.ts 在 get_login_info 成功后确认 online。
// 快照经 cordis 服务 `onebotStatus` 暴露给同进程的 backend 插件（backend 只读）。
// 状态不落盘：进程退出即消失，避免崩溃后留下假的「已连接」。
//
// 状态语义：
// - sleeping   插件未接线（未配置 wsUrl / 非归属实例 / 依赖缺失）
// - connecting 建连中，或 WS 已 open 但还没拿到登录信息
// - online     唯一可信的「已连上」：get_login_info 成功
// - offline    已断开，等待退避重连（retryInMs 由快照时实时计算）

import { Service } from 'cordis'
import type { Context } from 'cordis'

export type OnebotLinkState = 'sleeping' | 'connecting' | 'online' | 'offline'

export interface OnebotStatusSnapshot {
  state: OnebotLinkState
  /** 休眠原因（state=sleeping）。 */
  reason?: string
  /** 连接目标（不含 access token）。 */
  url: string
  /** 登录 QQ 号（get_login_info 成功后）。 */
  selfId?: number
  /** 登录昵称。 */
  nickname?: string
  /** 进入当前状态的时间（epoch ms）。 */
  since: number
  /** 最近一次断开 / 登录失败的原因。 */
  lastError?: string
  /** 连续重连次数（登录成功后清零）。 */
  attempts: number
  /** 距离下次重连的毫秒数（state=offline 时按快照时间实时计算）。 */
  retryInMs?: number
}

interface InternalSnapshot extends Omit<OnebotStatusSnapshot, 'retryInMs'> {
  retryAt?: number
}

/** 纯状态机：不碰 IO、不依赖 cordis，便于单测。 */
export class OnebotStatusStore {
  private snap: InternalSnapshot

  constructor(url: string, now = Date.now()) {
    this.snap = { state: 'connecting', url, since: now, attempts: 0 }
  }

  /** 插件未接线：明确写出原因，设置页据此显示灰灯。 */
  sleep(reason: string, now = Date.now()): void {
    this.snap = { state: 'sleeping', reason, url: this.snap.url, since: now, attempts: 0 }
  }

  /** 开始一次建连尝试，或 WS 已 open、等待登录信息。 */
  connecting(now = Date.now()): void {
    if (this.snap.state === 'sleeping' || this.snap.state === 'connecting') return
    this.snap = {
      state: 'connecting',
      url: this.snap.url,
      since: now,
      attempts: this.snap.attempts,
      ...(this.snap.lastError !== undefined ? { lastError: this.snap.lastError } : {}),
    }
  }

  /** get_login_info 成功才算真正连上；晚到的成功响应不能把 offline 翻回 online。 */
  online(selfId: number, nickname: string, now = Date.now()): void {
    if (this.snap.state !== 'connecting') return
    this.snap = {
      state: 'online',
      url: this.snap.url,
      since: now,
      attempts: 0,
      ...(selfId > 0 ? { selfId } : {}),
      ...(nickname !== '' ? { nickname } : {}),
    }
  }

  /** WS open 但登录信息拿不到：保持 connecting，留下原因。 */
  loginFailed(error: string, now = Date.now()): void {
    if (this.snap.state !== 'connecting') return
    this.snap = { ...this.snap, lastError: error, since: now }
  }

  /** 断开 / 建连失败：进入等待重连状态（保留上次登录身份便于辨认）。 */
  offline(error: string | undefined, retryInMs: number | undefined, now = Date.now()): void {
    if (this.snap.state === 'sleeping') return
    this.snap = {
      state: 'offline',
      url: this.snap.url,
      since: now,
      attempts: this.snap.attempts + 1,
      ...(error !== undefined && error !== '' ? { lastError: error } : {}),
      ...(retryInMs !== undefined ? { retryAt: now + retryInMs } : {}),
      ...(this.snap.selfId !== undefined ? { selfId: this.snap.selfId } : {}),
      ...(this.snap.nickname !== undefined ? { nickname: this.snap.nickname } : {}),
    }
  }

  snapshot(now = Date.now()): OnebotStatusSnapshot {
    const { retryAt, ...rest } = this.snap
    return {
      ...rest,
      ...(retryAt !== undefined ? { retryInMs: Math.max(0, retryAt - now) } : {}),
    }
  }
}

/** 跨插件只读契约（backend 用结构类型消费，不依赖本包）。 */
export interface OnebotStatusLike {
  snapshot(): OnebotStatusSnapshot
}

declare module 'cordis' {
  interface Context {
    onebotStatus: OnebotStatusService
  }
}

/** cordis 服务壳：注册名 `onebotStatus`，供 backend /api/plugins/onebot/status 读取。 */
export class OnebotStatusService extends Service {
  static inject: string[] = []
  private readonly store: OnebotStatusStore

  constructor(ctx: Context, url: string) {
    super(ctx, 'onebotStatus')
    this.store = new OnebotStatusStore(url)
  }

  snapshot(): OnebotStatusSnapshot {
    return this.store.snapshot()
  }

  sleep(reason: string): void {
    this.store.sleep(reason)
  }

  connecting(): void {
    this.store.connecting()
  }

  online(selfId: number, nickname: string): void {
    this.store.online(selfId, nickname)
  }

  loginFailed(error: string): void {
    this.store.loginFailed(error)
  }

  offline(error?: string, retryInMs?: number): void {
    this.store.offline(error, retryInMs)
  }
}
