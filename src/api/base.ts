// API 传输核：基址解析（active + 每实例）、鉴权令牌、JSON 请求、SSE 流。
// 端点函数在同级域模块（chat / models / plugins / presence）；本文件不定义协议形状。
//
// 基址语义：
// - dev（非 Tauri / Vite proxy）：active 实例用相对 `/api`，由 Vite 转发
// - release（Tauri 托管 UI）：`get_sidecar_url()` 拿 `http://127.0.0.1:<port>/api`
// - P2-3 多实例：instanceId 的基址来自运行时注册表（每实例一个 sidecar 端口），
//   **由本模块按需水合**——每个窗口一份，不依赖谁先调用
//   （跨源由 P2-1 CORS 白名单放行，令牌由 Authorization / ?token= 携带）

import type { InstanceRuntime } from "../ipc/instances";

let apiBase = "/api";
let apiToken = "";
/** 实例 id → `http://127.0.0.1:<port>/api`（运行时注册表水合，每窗口各自一份）。 */
const instanceBases = new Map<string, string>();
/** 水合最短间隔（含失败）：命中直接短路，未命中即重查，实例 sidecar 后起时可自愈。 */
const HYDRATE_MIN_INTERVAL_MS = 3000;
let hydratedAt = 0;
let hydrating: Promise<void> | null = null;
/** 注册表读到过（false = 非 Tauri dev / IPC 不可用：单实例语义，走 active 兜底）。 */
let registryKnown = false;

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

/** 目标实例的 API 根（缺省 = active 实例）。
 *
 * 指定实例时先按需水合注册表：查得到 = 该实例自己的 sidecar 端口；注册表读到过
 * 而该实例不在 = 它没在运行——明确报错，而不是静默回退 active。回退会让该实例的
 * 会话面显示并写入 active 实例的数据（多桌宠下即「两只宠物同一份对话」）。
 */
async function baseFor(instanceId?: string): Promise<string> {
  const active = initApiBase();
  if (!instanceId) return active;
  await hydrateInstanceBases();
  const base = instanceBases.get(instanceId);
  if (base) {
    await active; // 令牌就绪：实例基址同样走 Bearer 鉴权
    return base;
  }
  if (registryKnown) {
    throw new Error(`实例 ${instanceId} 未在运行（运行时注册表无记录），无法寻址它的会话`);
  }
  // 注册表不可读（纯浏览器 dev / IPC 失败）：只有 active 一个实例，沿用兜底。
  return active;
}

/** P2-3 多实例：喂入实例运行时行（id/port），供 per-instance 聊天寻址。 */
export function setInstanceRuntimes(rows: Array<{ id: string; port: number }>): void {
  instanceBases.clear();
  for (const r of rows) {
    if (r.port > 0) instanceBases.set(r.id, `http://127.0.0.1:${r.port}/api`);
  }
}

/**
 * 拉运行时注册表并喂寻址表（返回行，供侧栏在线点复用）。
 *
 * 每个窗口各自水合：主窗与桌宠窗是独立 WebView（独立 JS 上下文 + WebView2
 * data 目录），主窗水合出的端口表桌宠窗看不见。桌宠窗缺这一步时
 * `baseFor(instanceId)` 全部落空并静默回退 active，多只桌宠就都显示并写入
 * active 实例的会话（2026-09-28 实测：`#/pet?instance=beta` 的 /api 请求
 * 全打到 default 的端口）。
 */
export async function refreshInstanceRuntimes(): Promise<InstanceRuntime[]> {
  const { listInstanceRuntimes } = await import("../ipc/instances");
  const rows = await listInstanceRuntimes();
  setInstanceRuntimes(rows);
  registryKnown = true;
  hydratedAt = Date.now();
  return rows;
}

/** 按需水合（并发去重 + 最短间隔）；注册表暂不可得则保持现状，下次请求再试。 */
async function hydrateInstanceBases(): Promise<void> {
  if (hydrating) return hydrating;
  if (Date.now() - hydratedAt < HYDRATE_MIN_INTERVAL_MS) return;
  hydrating = (async () => {
    try {
      await refreshInstanceRuntimes();
    } catch {
      /* 注册表暂不可得：保持现状，下次请求再试 */
    } finally {
      hydratedAt = Date.now();
      hydrating = null;
    }
  })();
  return hydrating;
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
  void baseFor(instanceId)
    .then((base) => {
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
    })
    // 未运行实例等寻址失败：交给调用方的错误面（否则成为未处理拒绝）
    .catch((err) => onError(err));
  return () => {
    closed = true;
    es?.close();
  };
}

export { json };
