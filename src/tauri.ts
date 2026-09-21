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

/** 壳端插件信息（cos profile 启停）。 */
export interface PluginInfo {
  id: string;
  packageName: string;
  displayName: string;
  description: string;
  kind: string;
  enabled: boolean;
  toggleable: boolean;
  source: string;
  present: boolean;
  advisory?: string | null;
}

/** 列出 companion 插件。 */
export function listPlugins(): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("list_plugins");
}

/** 启停插件并重启 sidecar。 */
export function togglePluginAndRestart(id: string, enabled: boolean): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("toggle_plugin", { id, enabled });
}

/** 仅写启停状态，不重启。 */
export function setPluginEnabled(id: string, enabled: boolean): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("set_plugin_enabled", { id, enabled });
}

/** 预检报告（P3）。 */
export interface PreflightReport {
  ok: boolean;
  profile: string;
  safeMode: boolean;
  problems: string[];
  quarantined?: string | null;
  bundleDir: string;
  pluginsRoot: string;
  profileDir: string;
  harnessDir: string;
}

/** 当前激活 profile。 */
export function getActiveProfile(): Promise<string> {
  return invoke<string>("get_active_profile");
}

/** 启动预检。 */
export function preflightPlugins(): Promise<PreflightReport> {
  return invoke<PreflightReport>("preflight_plugins");
}

/** 切换 profile（companion / safe）并重启 sidecar。 */
export function switchProfile(profile: "companion" | "safe"): Promise<PreflightReport> {
  return invoke<PreflightReport>("switch_profile", { profile });
}

/** 安装 profile 插件（file: / git / npm）。 */
export function installProfilePlugin(spec: string, restart = true): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("install_profile_plugin", { spec, restart });
}

/** 卸载 profile 插件（internal 会被拒绝）。 */
export function uninstallProfilePlugin(id: string, restart = true): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("uninstall_profile_plugin", { id, restart });
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

/** 桌宠拖动结束后软恢复：夹到最近可见显示器工作区（跨屏拖动用，非拖动中实时 clamp）。 */
export async function clampPetWindow(): Promise<void> {
  if (!tauriAvailable()) return;
  try {
    await invoke<void>("clamp_pet_window");
  } catch {
    /* 忽略 */
  }
}

/**
 * 按物理像素增量移动桌宠窗口，并夹进最近显示器。
 * `deltaX/deltaY = 0` 时等价于软恢复（对齐 DSH `move_pet_window`）。
 * 实际需要挪动时带 ease-out 过渡（约 200ms）。
 */
export async function movePetWindow(deltaX: number, deltaY: number): Promise<void> {
  if (!tauriAvailable()) return;
  try {
    await invoke<void>("move_pet_window", { deltaX, deltaY });
  } catch {
    /* 忽略 */
  }
}

/** 取消进行中的桌宠位置过渡动画（再次开始拖动前调用）。 */
export async function cancelPetMoveAnimation(): Promise<void> {
  if (!tauriAvailable()) return;
  try {
    await invoke<void>("cancel_pet_move_animation");
  } catch {
    /* 忽略 */
  }
}

/**
 * 标记桌宠系统拖动会话。
 * `true`：拖动中，禁止归位 set_position/动画；
 * `false`：已结束，随后的 move_pet_window 可走 ease-out 过渡。
 */
export async function setPetDragging(active: boolean): Promise<void> {
  if (!tauriAvailable()) return;
  try {
    await invoke<void>("set_pet_dragging", { active });
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

/** 桌宠窗口配置（位置 + 缩放百分比）。 */
export interface PetWindowConfig {
  x: number | null;
  y: number | null;
  sizePercent: number;
}

/** 读取桌宠窗口配置。 */
export function getPetWindowConfig(): Promise<PetWindowConfig> {
  return invoke<PetWindowConfig>("get_pet_window_config");
}

/** 设置桌宠缩放百分比（50–200）并立即应用。 */
export function setPetSizePercent(percent: number): Promise<PetWindowConfig> {
  return invoke<PetWindowConfig>("set_pet_size_percent", { percent });
}

/** 显示桌宠窗口（异步：创建必须离开主线程）。 */
export function showPetWindow(): Promise<void> {
  return invoke<void>("show_pet_window");
}

/** 收起桌宠窗口 = 销毁实例（释放 WebView/GPU）。 */
export function hidePetWindow(): Promise<void> {
  return invoke<void>("hide_pet_window");
}

/** 切换桌宠显隐，返回切换后是否可见。 */
export function togglePetWindow(): Promise<boolean> {
  return invoke<boolean>("toggle_pet_window");
}

/** 全局快捷键绑定（壳端配置，热插拔：运行时注册/注销）。 */
export type ShortcutAction = "show-main" | "toggle-main" | "toggle-pet" | "show-pet" | "hide-pet";

export interface ShortcutBinding {
  id: string;
  accelerator: string;
  action: ShortcutAction;
  enabled: boolean;
}

/** 动作展示名（与 Rust 侧 ShortcutAction::display_name 对应）。 */
export const SHORTCUT_ACTION_LABELS: Record<ShortcutAction, string> = {
  "show-main": "唤起主窗口",
  "toggle-main": "切换主窗口",
  "toggle-pet": "切换桌宠",
  "show-pet": "显示桌宠",
  "hide-pet": "收起桌宠",
};

/** 列出全局快捷键绑定。 */
export function listShortcuts(): Promise<ShortcutBinding[]> {
  return invoke<ShortcutBinding[]>("list_shortcuts");
}

/** 热插拔：新增/更新绑定（写配置 + 运行时注册/注销）。 */
export function setShortcut(binding: ShortcutBinding): Promise<ShortcutBinding[]> {
  return invoke<ShortcutBinding[]>("set_shortcut", { binding });
}

/** 热插拔：移除绑定（写配置 + 运行时注销）。 */
export function removeShortcut(id: string): Promise<ShortcutBinding[]> {
  return invoke<ShortcutBinding[]>("remove_shortcut", { id });
}

/** 启动/重绑桌宠全局鼠标流。
 * Rust 以 16ms 节流 emit `device-mouse-move`，用于穿透态下恢复交互。
 */
export async function startPetMouseStream(): Promise<void> {
  await invoke<void>("start_pet_mouse_stream");
}
