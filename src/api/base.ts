// API 传输核：基址解析（active + 每实例）、鉴权令牌、JSON 请求、SSE 流。
// 端点函数在同级域模块（chat / models / plugins / presence）；本文件不定义协议形状。
//
// 基址语义：
// - dev（非 Tauri / Vite proxy）：active 实例用相对 `/api`，由 Vite 转发
// - release（Tauri 托管 UI）：`get_sidecar_url()` 拿 `http://127.0.0.1:<port>/api`
// - P2-3 多实例：`setInstanceRuntimes` 喂注册表行后，instanceId 可寻址任意实例
//   （跨源由 P2-1 CORS 白名单放行，令牌由 Authorization / ?token= 携带）

let apiBase = "/api";
let apiToken = "";
/** 实例 id → `http://127.0.0.1:<port>/api`（注册表就绪行喂入）。 */
const instanceBases = new Map<string, string>();

async function initApiBase(): Promise<string> {
  if (apiBase !== "/api") return apiBase;
  try {
    const { getSidecarApiBase, getServiceToken } = await import("../tauri");
    const [base, token] = await Promise.all([getSidecarApiBase(), getServiceToken()]);
    apiToken = token;
    if (base) apiBase = `${base}/api`;
  } catch {
    /* 保持相对路径（非 Tauri / dev） */
  }
  return apiBase;
}

/** P2-3 多实例：喂入实例运行时行（id/port），供 per-instance 聊天寻址。 */
export function setInstanceRuntimes(rows: Array<{ id: string; port: number }>): void {
  instanceBases.clear();
  for (const r of rows) {
    if (r.port > 0) instanceBases.set(r.id, `http://127.0.0.1:${r.port}/api`);
  }
}

/** 目标实例的 API 根（缺省 / 未登记 = active 实例）。 */
async function baseFor(instanceId?: string): Promise<string> {
  if (instanceId) {
    const b = instanceBases.get(instanceId);
    if (b) return b;
  }
  return initApiBase();
}

async function json<T>(url: string, init?: RequestInit, instanceId?: string): Promise<T> {
  const base = await baseFor(instanceId);
  const res = await fetch(`${base}${url}`, {
    headers: {
      "Content-Type": "application/json",
      // P2-1 / BUG-002：本地服务鉴权令牌（非 Tauri 环境留空，由 Vite proxy 注入）。
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
    },
    ...init,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).error ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(detail || `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/** 打开 SSE 事件流（按实例寻址），返回关闭函数。 */
export function streamEvents(
  onEvent: (e: import("../types").StreamEvent) => void,
  onError: (err: unknown) => void,
  instanceId?: string,
): () => void {
  let es: EventSource | null = null;
  let closed = false;
  void baseFor(instanceId).then((base) => {
    if (closed) return;
    // EventSource 无法带请求头：令牌走 ?token= 查询参数（P2-1 / BUG-002）。
    const sep = base.includes("?") ? "&" : "?";
    const url = apiToken
      ? `${base}/stream${sep}token=${encodeURIComponent(apiToken)}`
      : `${base}/stream`;
    es = new EventSource(url);
    es.addEventListener("event", (raw) => {
      try {
        const e = JSON.parse((raw as MessageEvent).data) as import("../types").StreamEvent;
        onEvent(e);
      } catch (err) {
        onError(err);
      }
    });
    es.onerror = (err) => onError(err);
  });
  return () => {
    closed = true;
    es?.close();
  };
}

export { json };
