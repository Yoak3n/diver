// 窗口启动配置 + 主窗口自定义标题栏 IPC。

import { invoke, tauriAvailable } from "./core";

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

type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  startDragging: () => Promise<void>;
  onResized: (handler: () => void) => Promise<() => void>;
};

async function currentWindow(): Promise<TauriWindow | null> {
  if (!tauriAvailable()) return null;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow() as unknown as TauriWindow;
  } catch {
    return null;
  }
}

/** 最小化当前窗口。 */
export async function windowMinimize(): Promise<void> {
  try {
    await (await currentWindow())?.minimize();
  } catch {
    /* 忽略 */
  }
}

/** 最大化 / 还原切换。 */
export async function windowToggleMaximize(): Promise<void> {
  try {
    await (await currentWindow())?.toggleMaximize();
  } catch {
    /* 忽略 */
  }
}

/**
 * 关闭当前窗口。
 * 主窗口 CloseRequested 会被壳端拦截为隐藏（托盘常驻），与原生 X 行为一致。
 */
export async function windowClose(): Promise<void> {
  try {
    await (await currentWindow())?.close();
  } catch {
    /* 忽略 */
  }
}

/** 开始系统窗口拖动（自定义标题栏拖拽区）。 */
export async function windowStartDragging(): Promise<void> {
  try {
    await (await currentWindow())?.startDragging();
  } catch {
    /* 忽略 */
  }
}

/** 当前是否最大化（标题栏切换还原图标）。 */
export async function windowIsMaximized(): Promise<boolean> {
  try {
    return (await (await currentWindow())?.isMaximized()) ?? false;
  } catch {
    return false;
  }
}

/** 监听窗口尺寸变化（最大化状态同步）。返回取消监听函数。 */
export async function onWindowResized(handler: () => void): Promise<() => void> {
  const win = await currentWindow();
  if (!win) return () => {};
  try {
    return await win.onResized(handler);
  } catch {
    return () => {};
  }
}
