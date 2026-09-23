/**
 * Shared client for the Tauri shell's local HTTP RPC (`POST 127.0.0.1:$DIVER_MEMORY_PORT/rpc`).
 *
 * Every Rust-backed capability (memory SQLite, grep, future native services)
 * must go through this module — do not invent a second port or envelope.
 *
 * Wire format (src-tauri/src/services/rpc.rs):
 *   request  { method, params }
 *   response { ok: true, data } | { ok: false, error }
 *
 * @module @diver/native-bridge/rpc
 */

export interface NativeRpcEnvelope<T> {
  ok: boolean
  data: T | null
  error?: string
}

/** Known method surface (extend when adding Rust routes; docs + native_status). */
export const NATIVE_RPC_METHODS = [
  {
    method: 'stats',
    service: 'memory',
    description: '记忆库统计（topics / events / promises）',
    /** false = 有副作用，禁止真调探测（否则会弹真实系统通知）。 */
    probeSafe: true as boolean,
  },
  {
    method: 'snapshot',
    service: 'memory',
    description: '关系卡 + topics/promises/events 快照',
    probeSafe: true as boolean,
  },
  {
    method: 'grep::search',
    service: 'grep',
    description: 'ripgrep 文件内容搜索（diver-search crate）',
    probeSafe: true as boolean,
  },
  {
    method: 'notify::show',
    service: 'notify',
    description: '原生托盘通知（agent 主动消息 / 日程提醒到达时弹通知）',
    probeSafe: false as boolean,
  },
  {
    method: 'notify::ping',
    service: 'notify',
    description: '通知通道连通性探测（不弹通知）',
    probeSafe: true as boolean,
  },
  {
    method: 'presence::ping',
    service: 'presence',
    description: 'Companion Presence 连通性探测',
    probeSafe: true as boolean,
  },
  {
    method: 'presence::phase',
    service: 'presence',
    description: '当前存在感相位（叶子名）',
    probeSafe: true as boolean,
  },
  {
    method: 'presence::snapshot',
    service: 'presence',
    description: '存在感调试快照（相位 + ProactiveSpeak 记账）',
    probeSafe: true as boolean,
  },
  {
    method: 'presence::busy',
    service: 'presence',
    description: 'agent busy 回压（L0 activity）',
    probeSafe: true as boolean,
  },
  {
    method: 'presence::event',
    service: 'presence',
    description: '驱动 L0 事件（USER_CHAT / CHAT_ACTIVITY / …）',
    probeSafe: true as boolean,
  },
  {
    method: 'presence::request_inject',
    service: 'presence',
    description: '裁决主动注入（L1+L2；通过返回 inject 载荷）',
    probeSafe: false as boolean,
  },
] as const

/** `http://127.0.0.1:{DIVER_MEMORY_PORT}/rpc`，未配置时返回 null。 */
export function nativeRpcUrl(): string | null {
  const port = process.env.DIVER_MEMORY_PORT
  if (!port || port.trim() === '') return null
  return `http://127.0.0.1:${port}/rpc`
}

export function nativeRpcConfigured(): boolean {
  return nativeRpcUrl() !== null
}

/**
 * POST one RPC method.
 * @param method - e.g. `stats` / `grep::search`
 * @param params - JSON object params
 * @param options.label - error prefix (default = method)
 */
export async function nativeRpc<T>(
  method: string,
  params: Record<string, unknown> = {},
  options: { label?: string } = {},
): Promise<T> {
  const label = options.label ?? method
  const url = nativeRpcUrl()
  if (url === null) {
    throw new Error(`${label}: Rust 本地服务未启动（DIVER_MEMORY_PORT 未配置）`)
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  let body: NativeRpcEnvelope<T>
  try {
    body = (await res.json()) as NativeRpcEnvelope<T>
  } catch {
    throw new Error(`${label}: RPC 响应不是 JSON (HTTP ${res.status})`)
  }
  if (!body.ok) {
    throw new Error(body.error ?? `${label}: rpc failed (${method})`)
  }
  return body.data as T
}

/** Probe one method; never throws. */
export async function probeNativeRpc(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ method: string; ok: boolean; detail: string }> {
  if (!nativeRpcConfigured()) {
    return { method, ok: false, detail: 'DIVER_MEMORY_PORT 未配置' }
  }
  try {
    const data = await nativeRpc<unknown>(method, params, { label: method })
    const preview =
      data === null || data === undefined
        ? 'null'
        : typeof data === 'object'
          ? `{${Object.keys(data as object).slice(0, 6).join(',')}}`
          : String(data).slice(0, 80)
    return { method, ok: true, detail: preview }
  } catch (e) {
    return { method, ok: false, detail: (e as Error)?.message ?? String(e) }
  }
}
