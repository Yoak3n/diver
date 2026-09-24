// Tauri IPC 核心：环境探测、invoke 薄封装、跨窗口事件。

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function tauriAvailable(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!tauriAvailable()) {
    throw new Error("不在 Tauri 环境中");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** 监听 Tauri 事件。 */
export async function onTauriEvent<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!tauriAvailable()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => handler(e.payload));
}

/** 广播 Tauri 事件（跨窗口）。 */
export async function emitTauriEvent(event: string, payload?: unknown): Promise<void> {
  if (!tauriAvailable()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(event, payload);
}
