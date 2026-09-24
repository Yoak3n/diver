// 助手头像 IPC（自定义聊天头像，存壳层本地）。

import { invoke, onTauriEvent, tauriAvailable } from "./core";

export interface AvatarView {
  /** data URL；null = 使用默认 ✦ */
  dataUrl: string | null;
  /** $COS_HOME/assistant-avatar.<ext>（供设置展示 / agent 写入） */
  path: string;
}

export function getAssistantAvatar(): Promise<AvatarView> {
  return invoke<AvatarView>("get_assistant_avatar");
}

/** data 为不带 data: 前缀的 base64。 */
export function setAssistantAvatar(mime: string, data: string): Promise<AvatarView> {
  return invoke<AvatarView>("set_assistant_avatar", { mime, data });
}

export function clearAssistantAvatar(): Promise<AvatarView> {
  return invoke<AvatarView>("clear_assistant_avatar");
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
