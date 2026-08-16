// Diver 陪伴 UI — Tauri 原生能力封装（无 Tauri 环境时优雅降级）

import type { SidecarStatus } from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function tauriAvailable(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!tauriAvailable()) {
    throw new Error("不在 Tauri 环境中");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** 本地 TTS 朗读。 */
export function speakText(text: string, voice?: string): Promise<boolean> {
  return invoke<boolean>("speak", { text, voice: voice || null });
}

/** 列出系统 TTS 语音。 */
export function listVoices(): Promise<string[]> {
  return invoke<string[]>("list_voices");
}

/** sidecar 状态。 */
export function getSidecarStatus(): Promise<SidecarStatus> {
  return invoke<SidecarStatus>("get_sidecar_status");
}

/** 重启 sidecar。 */
export function restartSidecar(): Promise<boolean> {
  return invoke<boolean>("restart_sidecar");
}

/** 监听 Tauri 事件。 */
export async function onTauriEvent<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!tauriAvailable()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => handler(e.payload));
}

/** 启动窗口配置。 */
export interface WindowStartupConfig {
  autoOpenMain: boolean;
  autoOpenPet: boolean;
}

/** 读取启动窗口配置。 */
export function getWindowStartupConfig(): Promise<WindowStartupConfig> {
  return invoke<WindowStartupConfig>("get_window_startup_config");
}

/** 保存启动窗口配置。 */
export function setWindowStartupConfig(config: WindowStartupConfig): Promise<boolean> {
  return invoke<boolean>("set_window_startup_config", { config });
}
