// Diver 陪伴 UI — sidecar API 客户端（自有协议，见 harness/companion-web）

import type { HealthInfo, SettingsInfo, StreamEvent } from "./types";

const BASE = "/api";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
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
  const es = new EventSource(`${BASE}/stream`);
  es.addEventListener("event", (raw) => {
    try {
      const e = JSON.parse((raw as MessageEvent).data) as StreamEvent;
      onEvent(e);
    } catch (err) {
      onError(err);
    }
  });
  es.onerror = (err) => onError(err);
  return () => es.close();
}
