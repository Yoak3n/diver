// @diver/onebot — OneBot 11 正向 WebSocket 客户端（薄传输层）。
//
// 职责边界：连接/重连/心跳容错、API 调用（echo 匹配）、事件分发；不理解
// 业务语义。鉴权走标准 access_token 查询参数（NapCat / Lagrange / LLOneBot
// 通用），不依赖自定义 HTTP 头（Node 原生 WebSocket 不支持）。

import type { GroupMessageEvent, PrivateMessageEvent } from './protocol.ts'
import { parseEvent } from './protocol.ts'

export interface OnebotClientOptions {
  /** 如 ws://127.0.0.1:3001。 */
  url: string
  token: string
  onGroupMessage: (event: GroupMessageEvent) => void
  onPrivateMessage: (event: PrivateMessageEvent) => void
  /** 连接状态变化（index.ts 用 connected 拉 get_login_info）。 */
  onStatus?: (status: 'connected' | 'disconnected') => void
}

interface PendingCall {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const RECONNECT_BASE_MS = 1000
const RECONNECT_CAP_MS = 60_000
const CALL_TIMEOUT_MS = 15_000

export class OnebotClient {
  private ws: WebSocket | undefined
  private stopped = false
  private backoffMs = RECONNECT_BASE_MS
  private seq = 0
  private readonly pending = new Map<string, PendingCall>()
  private reconnectTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: OnebotClientOptions) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    try {
      this.ws?.close()
    } catch {
      // 关闭失败不影响退出
    }
    this.ws = undefined
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
    const url = this.options.token === ''
      ? this.options.url
      : `${this.options.url}${this.options.url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.options.token)}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (error) {
      console.warn(`[onebot] 建连失败（将重试）：${String(error)}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.backoffMs = RECONNECT_BASE_MS
      console.log(`[onebot] 已连接 ${this.options.url}`)
      this.options.onStatus?.('connected')
    })
    ws.addEventListener('message', (event: MessageEvent) => this.handleMessage(event))
    ws.addEventListener('error', () => {
      // close 紧随其后，重连逻辑统一在 close
    })
    ws.addEventListener('close', () => {
      for (const [echo, call] of this.pending) {
        clearTimeout(call.timer)
        call.reject(new Error('OneBot 连接已断开'))
        this.pending.delete(echo)
      }
      if (this.stopped) return
      console.warn(`[onebot] 连接断开，${Math.round(this.backoffMs / 1000)}s 后重连`)
      this.options.onStatus?.('disconnected')
      this.scheduleReconnect()
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
