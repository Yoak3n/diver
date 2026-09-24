// 桌宠窗口几何 / 显隐 / 拖动 / 鼠标流 IPC。

import { invoke, tauriAvailable } from "./core";

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

/** 桌宠窗口是否在线（在线时朗读必须交给桌宠，避免双窗口叠播）。 */
export async function isPetWindowOpen(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_pet_window_open");
  } catch {
    return false;
  }
}

/** 启动/重绑桌宠全局鼠标流。
 * Rust 以 16ms 节流 emit `device-mouse-move`，用于穿透态下恢复交互。
 */
export async function startPetMouseStream(): Promise<void> {
  await invoke<void>("start_pet_mouse_stream");
}
