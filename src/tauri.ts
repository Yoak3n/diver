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
    // 兜底：状态已是 running 直接放行（事件可能在 WebView 挂载前已发出）
    void getSidecarStatus()
      .then((s) => {
        if (s.state === "running") finish(true);
      })
      .catch(() => {});
    // 主信号：等 backend://ready 事件
    void onTauriEvent<SidecarStatus>("backend://ready", () => finish(true)).then((u) => {
      unlisten = u;
      // 事件可能在监听建立前已发出：监听就绪后再查一次状态
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

/** MCP 服务配置（设置面板「MCP 服务」页直接编辑的文件，见 config/mcp.rs）。 */
export interface McpServerConfig {
  transport: "stdio";
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  toolCallTimeoutMs: number;
}

export interface McpConfig {
  servers: McpServerConfig[];
}

/** 读取 MCP 服务配置。 */
export function getMcpConfig(): Promise<McpConfig> {
  return invoke<McpConfig>("get_mcp_config");
}

/** 保存 MCP 服务配置，返回是否成功。 */
export function saveMcpConfig(config: McpConfig): Promise<boolean> {
  return invoke<boolean>("save_mcp_config", { config });
}

/** 查询全局鼠标在屏幕上的物理坐标（用于桌宠点击穿透判定）。失败返回 null。 */
export async function getCursorScreenPoint(): Promise<{ x: number; y: number } | null> {
  try {
    const p = await invoke<[number, number] | null>("get_cursor_screen_point");
    if (!p) return null;
    return { x: p[0], y: p[1] };
  } catch {
    return null;
  }
}

/** 桌宠拖动结束后调用：把窗口拉回"中心点所在显示器"的工作区内（多屏安全）。 */
export async function clampPetWindow(): Promise<void> {
  if (!tauriAvailable()) return;
  try {
    await invoke<void>("clamp_pet_window");
  } catch {
    /* 忽略 */
  }
}

/** 列出所有显示器（物理像素坐标）。 */
export interface MonitorInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 列出所有显示器（用于把桌宠转移到指定屏幕）。 */
export async function listMonitors(): Promise<MonitorInfo[]> {
  if (!tauriAvailable()) return [];
  try {
    return await invoke<MonitorInfo[]>("list_monitors");
  } catch {
    return [];
  }
}

/** 把桌宠窗口转移到指定显示器（贴其右下角）。 */
export async function movePetToMonitor(index: number): Promise<boolean> {
  if (!tauriAvailable()) return false;
  try {
    return await invoke<boolean>("move_pet_to_monitor", { index });
  } catch {
    return false;
  }
}
