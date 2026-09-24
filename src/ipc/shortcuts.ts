// 全局快捷键绑定 IPC。

import { invoke } from "./core";

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

/** 录制组合键前：挂起全部全局热键，避免 OS 吞掉 keydown。 */
export function suspendShortcuts(): Promise<void> {
  return invoke<void>("suspend_shortcuts");
}

/** 录制组合键后：按配置恢复全局热键。 */
export function resumeShortcuts(): Promise<void> {
  return invoke<void>("resume_shortcuts");
}
