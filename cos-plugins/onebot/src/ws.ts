// @diver/onebot — OneBot 11 正向 WebSocket 客户端（薄传输层）。
//
// 职责边界：连接/重连/心跳容错、API 调用（echo 匹配）、事件分发；不理解
// 业务语义。鉴权走标准 access_token 查询参数（NapCat / Lagrange / LLOneBot
// 通用），不依赖自定义 HTTP 头（Node 原生 WebSocket 不支持）。

import type { GroupMessageEvent, PrivateMessageEvent } from './protocol.ts'
import { parseEvent } from './protocol.ts'

export type OnebotLinkStatus = 'connecting' | 'connected' | 'disconnected'

export interface OnebotLinkEvent {
  status: OnebotLinkStatus
  /** WS 关闭码 / 建连异常（disconnected 时）。 */
  code?: number
  reason?: string
  /** 距离下次重连的等待（毫秒，disconnected 时）。 */
  retryMs?: number
}

export interface OnebotClientOptions {
  /** 如 ws://127.0.0.1:3001。 */
  url: string
  token: string
  onGroupMessage: (event: GroupMessageEvent) => void
  onPrivateMessage: (event: PrivateMessageEvent) => void
  /** 连接状态变化（index.ts 用 connected 拉 get_login_info，失败原因进状态灯）。 */
  onStatus?: (event: OnebotLinkEvent) => void
  /** WebSocket 构造器（测试注入；缺省全局 WebSocket）。 */
  createSocket?: (url: string) => WebSocket
}

interface PendingCall {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const RECONNECT_BASE_MS = 1000
const RECONNECT_CAP_MS = 60_000
const CALL_TIMEOUT_MS = 15_000
/**
 * open 后稳定存活多久算健康（无 get_login_info 的实现也退避复位）。
 * 认证失败的服务端会 open 后立即 close，不能一 open 就重置退避。
 */
const HEALTHY_AFTER_OPEN_MS = 10_000

/** WebSocket error 事件 → 可读原因（Node/undici 的 Event 可能没有 message）。 */
function linkErrorText(event: Event): string {
  const message = (event as { message?: unknown }).message
  if (typeof message === 'string' && message !== '') return message
  const error = (event as { error?: unknown }).error
  if (error instanceof Error && error.message !== '') return error.message
  return 'WebSocket 连接失败'
}

export class OnebotClient {
  private ws: WebSocket | undefined
  private stopped = false
  private backoffMs = RECONNECT_BASE_MS
  private seq = 0
  private readonly pending = new Map<string, PendingCall>()
  private reconnectTimer: NodeJS.Timeout | undefined
  private healthyTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: OnebotClientOptions) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.clearHealthyTimer()
    this.rejectPending('OneBot 连接已断开')
    try {
      this.ws?.close()
    } catch {
      // 关闭失败不影响退出
    }
    this.ws = undefined
  }

  /** 连接已确认可用（登录成功或稳定存活）：重置重连退避。 */
  markHealthy(): void {
    this.clearHealthyTimer()
    if (this.ws?.readyState === WebSocket.OPEN) this.backoffMs = RECONNECT_BASE_MS
  }

  private clearHealthyTimer(): void {
    if (this.healthyTimer === undefined) return
    clearTimeout(this.healthyTimer)
    this.healthyTimer = undefined
  }

  /** 断连时拒绝所有待回执调用（连接被拒、没有 close 的运行时也走这里）。 */
  private rejectPending(message: string): void {
    for (const [echo, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error(message))
      this.pending.delete(echo)
    }
  }

  /** OneBot API 调用：echo 匹配 JSON 响应；超时/断连拒绝。 */
  call<T = unknown>(action: string, params: Record<string, unknown> = {}, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    const ws = this.ws
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('OneBot 未连接'))
    }
    const echo = `ob-${this.seq++}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot API 超时：${action}`))
      }, timeoutMs)
      this.pending.set(echo, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      })
      try {
        ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private connect(): void {
    if (this.stopped) return
    this.options.onStatus?.({ status: 'connecting' })
    const url = this.options.token === ''
      ? this.options.url
      : `${this.options.url}${this.options.url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.options.token)}`
    let ws: WebSocket
    try {
      ws = (this.options.createSocket ?? ((target: string) => new WebSocket(target)))(url)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(`[onebot] 建连失败（将重试）：${reason}`)
      this.options.onStatus?.({ status: 'disconnected', reason, retryMs: this.backoffMs })
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    // 一次连接只结算一次：error 与 close 可能先后到达，也可能只有 error。
    let settled = false
    const fail = (reason: string, code?: number): void => {
      if (settled) return
      settled = true
      if (this.ws === ws) this.ws = undefined
      this.clearHealthyTimer()
      this.rejectPending('OneBot 连接已断开')
      try {
        ws.close()
      } catch {
        // 已经关闭/不可关闭：不影响重连
      }
      if (this.stopped) return
      console.warn(`[onebot] ${reason}，${Math.round(this.backoffMs / 1000)}s 后重连`)
      this.options.onStatus?.({
        status: 'disconnected',
        ...(code !== undefined ? { code } : {}),
        reason,
        retryMs: this.backoffMs,
      })
      this.scheduleReconnect()
    }

    ws.addEventListener('open', () => {
      console.log(`[onebot] 已连接 ${this.options.url}`)
      this.options.onStatus?.({ status: 'connected' })
      // 不在这里重置退避：token 错误时服务端同样会 open 后立刻 close。
      this.healthyTimer = setTimeout(() => this.markHealthy(), HEALTHY_AFTER_OPEN_MS)
    })
    ws.addEventListener('message', (event: MessageEvent) => this.handleMessage(event))
    ws.addEventListener('error', (event: Event) => {
      // Node 22（undici）连接被拒时只发 error、不发 close（readyState 停在
      // CONNECTING）。不能等 close 才重连，否则一次失败就永久卡死；settled
      // 保证 close 随后到达时只结算一次。
      fail(linkErrorText(event))
    })
    ws.addEventListener('close', (event: CloseEvent) => {
      fail(
        event.reason !== '' ? event.reason : `连接已关闭（code ${event.code}）`,
        event.code,
      )
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_CAP_MS)
  }

  private handleMessage(event: MessageEvent): void {
    let raw: unknown
    try {
      raw = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (typeof raw !== 'object' || raw === null) return
    const payload = raw as Record<string, unknown>

    // API 响应：带 echo 且无 post_type
    const echo = payload.echo
    if (typeof echo === 'string' && payload.post_type === undefined) {
      const call = this.pending.get(echo)
      if (call === undefined) return
      this.pending.delete(echo)
      clearTimeout(call.timer)
      if (payload.status === 'failed' || payload.retcode !== 0 && payload.retcode !== undefined) {
        call.reject(new Error(String(payload.wording ?? payload.message ?? 'OneBot 调用失败')))
      } else {
        call.resolve(payload.data)
      }
      return
    }

    const parsed = parseEvent(raw)
    if (parsed === undefined) return
    if (parsed.post_type === 'message') {
      if (parsed.message_type === 'group') this.options.onGroupMessage(parsed)
      else this.options.onPrivateMessage(parsed)
    }
    // meta_event（heartbeat/lifecycle）忽略：连接活性由 WS 层保证
  }
}
