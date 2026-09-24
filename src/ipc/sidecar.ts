// sidecar 生命周期与就绪信号 IPC。

import type { SidecarStatus } from "../types";
import { invoke, onTauriEvent, tauriAvailable } from "./core";

/** sidecar 状态。 */
export function getSidecarStatus(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>("get_sidecar_status");
}

/**
 * sidecar API 基址（不含 /api 后缀），如 `http://127.0.0.1:53620`。
 *
 * UI 由 Tauri 内置静态托管（dev 为 Vite、release 为 frontendDist）后，
 * 页面 origin 不再是 sidecar —— `/api` 相对路径不指向 sidecar，必须显式
 * 用 Rust 侧的 get_sidecar_url 拿绝对地址。非 Tauri 环境（纯浏览器 dev）
 * 返回空串，由 api.ts 回退相对路径（Vite proxy 转发）。
 */
export async function getSidecarApiBase(): Promise<string> {
  if (!tauriAvailable()) return "";
  try {
    return await invoke<string>("get_sidecar_url");
  } catch {
    return "";
  }
}

/**
 * 等待 sidecar 后端就绪（可安全发起 /api 请求）。
 *
 * 信号来源：Rust 侧在 sidecar 打印 DIVER_READY 时发出 `backend://ready` 事件。
 * 该事件只在就绪瞬间发一次，若 WebView 挂载晚于事件发出（首次启动常见），
 * 这里再查一次 get_sidecar_status() 兜底。非 Tauri 环境（纯浏览器 dev）直接放行。
 * @returns 是否已就绪（超时返回 false，调用方按未就绪处理/重试）。
 */
export function waitForSidecarReady(timeoutMs = 15000): Promise<boolean> {
  if (!tauriAvailable()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let unlisten: (() => void) | null = null;
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unlisten?.();
      resolve(ok);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    void getSidecarStatus()
      .then((s) => {
        if (s.state === "running") finish(true);
      })
      .catch(() => {});
    void onTauriEvent<SidecarStatus>("backend://ready", () => finish(true)).then((u) => {
      unlisten = u;
      void getSidecarStatus()
        .then((s) => {
          if (s.state === "running") finish(true);
        })
        .catch(() => {});
    });
  });
}

/** 重启 sidecar。 */
export function restartSidecar(): Promise<boolean> {
  return invoke<boolean>("restart_sidecar");
}
