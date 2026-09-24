// 助手头像共享状态：模块级单例，主窗口/桌宠窗口各自加载，变更经 Tauri 事件同步。

import { ref } from "vue";
import {
  clearAssistantAvatar,
  emitAvatarChanged,
  getAssistantAvatar,
  onAvatarChanged,
  setAssistantAvatar,
} from "../ipc/avatar";
import { tauriAvailable } from "../tauri";

const avatarUrl = ref<string | null>(null);
const avatarPath = ref("");
let loaded = false;
let unlisten: (() => void) | null = null;

async function ensureListener(): Promise<void> {
  if (unlisten || !tauriAvailable()) return;
  unlisten = await onAvatarChanged((dataUrl) => {
    avatarUrl.value = dataUrl;
  });
}

/** 拉取头像（默认只拉一次；force=强制重读磁盘，供 agent 改文件后刷新）。 */
async function loadAvatar(force = false): Promise<void> {
  if (!tauriAvailable()) return;
  if (loaded && !force) return;
  await ensureListener();
  try {
    const v = await getAssistantAvatar();
    avatarUrl.value = v.dataUrl;
    avatarPath.value = v.path ?? "";
    loaded = true;
  } catch {
    /* 离线/非 Tauri：保持默认 */
  }
}

/** 从 File 设置头像（前端读 base64 后写入壳层）。 */
async function setAvatarFromFile(file: File): Promise<string | null> {
  const data = await fileToBase64(file);
  const v = await setAssistantAvatar(file.type || "image/png", data);
  avatarUrl.value = v.dataUrl;
  emitAvatarChanged(v.dataUrl);
  return v.dataUrl;
}

async function resetAvatar(): Promise<void> {
  const v = await clearAssistantAvatar();
  avatarUrl.value = v.dataUrl;
  emitAvatarChanged(v.dataUrl);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

/** 聊天/桌宠等展示处使用：null 时渲染默认 ✦。 */
export function useAssistantAvatar() {
  return {
    avatarUrl,
    avatarPath,
    loadAvatar,
    setAvatarFromFile,
    resetAvatar,
  };
}
