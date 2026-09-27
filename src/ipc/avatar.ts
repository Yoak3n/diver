// 助手头像 IPC（自定义聊天头像，存壳层本地）。

import { invoke, onTauriEvent, tauriAvailable } from "./core";

export interface AvatarView {
  /** data URL；null = 使用默认 ✦ */
  dataUrl: string | null;
  /** $COS_HOME/assistant-avatar.<ext>（供设置展示 / agent 写入） */
  path: string;
}

export function getAssistantAvatar(instanceId?: string): Promise<AvatarView> {
  return invoke<AvatarView>("get_assistant_avatar", {
    ...(instanceId ? { instance: instanceId } : {}),
  });
}

/** data 为不带 data: 前缀的 base64。`instanceId` 缺省 = active 实例。 */
export function setAssistantAvatar(
  mime: string,
  data: string,
  instanceId?: string,
): Promise<AvatarView> {
  return invoke<AvatarView>("set_assistant_avatar", {
    mime,
    data,
    ...(instanceId ? { instance: instanceId } : {}),
  });
}

/** 恢复默认头像（✦）。`instanceId` 缺省 = active 实例。 */
export function clearAssistantAvatar(instanceId?: string): Promise<AvatarView> {
  return invoke<AvatarView>("clear_assistant_avatar", {
    ...(instanceId ? { instance: instanceId } : {}),
  });
}

/** 跨窗口（主窗口 ↔ 桌宠）头像变更通知。 */
export const AVATAR_CHANGED_EVENT = "avatar://changed";

export function emitAvatarChanged(dataUrl: string | null): void {
  if (!tauriAvailable()) return;
  void import("@tauri-apps/api/event").then(({ emit }) => {
    void emit(AVATAR_CHANGED_EVENT, { dataUrl });
  });
}

export function onAvatarChanged(handler: (dataUrl: string | null) => void): Promise<() => void> {
  return onTauriEvent<{ dataUrl: string | null }>(AVATAR_CHANGED_EVENT, (p) => {
    handler(p?.dataUrl ?? null);
  });
}

// ---------- 应用图标（应用级品牌位，与实例头像无关） ----------

export function getAppIcon(): Promise<AvatarView> {
  return invoke<AvatarView>("get_app_icon");
}

export function setAppIcon(mime: string, data: string): Promise<AvatarView> {
  return invoke<AvatarView>("set_app_icon", { mime, data });
}

export function clearAppIcon(): Promise<AvatarView> {
  return invoke<AvatarView>("clear_app_icon");
}

/** 跨窗口应用图标变更通知。 */
export const APP_ICON_CHANGED_EVENT = "appicon://changed";

export function emitAppIconChanged(dataUrl: string | null): void {
  if (!tauriAvailable()) return;
  void import("@tauri-apps/api/event").then(({ emit }) => {
    void emit(APP_ICON_CHANGED_EVENT, { dataUrl });
  });
}

export function onAppIconChanged(handler: (dataUrl: string | null) => void): Promise<() => void> {
  return onTauriEvent<{ dataUrl: string | null }>(APP_ICON_CHANGED_EVENT, (p) => {
    handler(p?.dataUrl ?? null);
  });
}

// ---------- 群头像（按群 id 一份；侧栏群行 / 群管理面板使用） ----------

export function getGroupAvatar(groupId: string): Promise<AvatarView> {
  return invoke<AvatarView>("get_group_avatar", { groupId });
}

export function setGroupAvatar(groupId: string, mime: string, data: string): Promise<AvatarView> {
  return invoke<AvatarView>("set_group_avatar", { groupId, mime, data });
}

export function clearGroupAvatar(groupId: string): Promise<AvatarView> {
  return invoke<AvatarView>("clear_group_avatar", { groupId });
}
