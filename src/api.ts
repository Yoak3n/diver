// Diver 陪伴 UI — sidecar API 客户端（自有协议，见 harness/companion-web）

import type { ChatMessage, HealthInfo, SettingsInfo, StreamEvent } from "./types";

// sidecar API 基址：
// - dev（非 Tauri / Vite proxy）：相对 `/api`，由 Vite 转发到 sidecar
// - release（Tauri 托管 UI）：页面 origin 不是 sidecar，必须用
//   get_sidecar_url() 拿 `http://127.0.0.1:<port>` 绝对地址
let apiBase = "/api";

async function initApiBase(): Promise<string> {
  if (apiBase !== "/api") return apiBase;
  try {
    const { getSidecarApiBase } = await import("./tauri");
    const base = await getSidecarApiBase();
    if (base) apiBase = `${base}/api`;
  } catch {
    /* 保持相对路径（非 Tauri / dev） */
  }
  return apiBase;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const base = await initApiBase();
  const res = await fetch(`${base}${url}`, {
    headers: { "Content-Type": "application/json" },
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

export function health(): Promise<HealthInfo> {
  return json<HealthInfo>("/health");
}

export function getSettings(): Promise<SettingsInfo> {
  return json<SettingsInfo>("/settings");
}

export function saveSettings(body: {
  providerConfigs?: Record<string, Record<string, string>>;
  provider?: string;
  model?: string;
  ttsEnabled?: boolean;
  ttsVoice?: string;
}): Promise<{ modelConfigured: boolean; provider: string; model: string }> {
  return json("/settings", { method: "POST", body: JSON.stringify(body) });
}

export function sendChat(content: string): Promise<{ sessionId: string; messageId: string }> {
  return json("/chat", { method: "POST", body: JSON.stringify({ content }) });
}

/** 当前会话历史（重启后恢复界面）。 */
export function getHistory(): Promise<{ messages: ChatMessage[] }> {
  return json<{ messages: ChatMessage[] }>("/history");
}

/** 回答 ask_user_question 提出的问题。 */
export function answerQuestion(
  requestId: string,
  answers: { id: string; selected: string[]; custom?: string }[],
): Promise<{ ok: boolean }> {
  return json("/questions/answer", {
    method: "POST",
    body: JSON.stringify({ requestId, answers }),
  });
}

/** 打开 SSE 事件流，返回关闭函数。 */
export function streamEvents(
  onEvent: (e: StreamEvent) => void,
  onError: (err: unknown) => void,
): () => void {
  let es: EventSource | null = null;
  let closed = false;
  void initApiBase().then((base) => {
    if (closed) return;
    es = new EventSource(`${base}/stream`);
    es.addEventListener("event", (raw) => {
      try {
        const e = JSON.parse((raw as MessageEvent).data) as StreamEvent;
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
