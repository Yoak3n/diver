// 助手头像共享状态：模块级单例，主窗口/桌宠窗口各自加载，变更经 Tauri 事件同步。

import { ref } from "vue";
import {
  clearAssistantAvatar,
  emitAvatarChanged,
  getAssistantAvatar,
  onAvatarChanged,
  setAssistantAvatar,
} from "../ipc/avatar";
import { fileToSquareImage } from "../imageAttach";
import { tauriAvailable } from "../tauri";

const avatarUrl = ref<string | null>(null);
const avatarPath = ref("");
let loaded = false;
let unlisten: (() => void) | null = null;

async function ensureListener(): Promise<void> {
  if (unlisten || !tauriAvailable()) return;
  unlisten = await onAvatarChanged(() => {
    // 变更可能来自任意实例：active 头像重读磁盘，按实例缓存整体失效。
    // 不直接采纳载荷 dataUrl——改的可能不是本窗口展示的实例。
    instanceAvatars.clear();
    bumpInstanceAvatars();
    void loadAvatar(true);
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

/** 从 File 设置头像（中心方裁 + 缩到 256×256 后写入壳层）。`instanceId` 缺省 = active 实例。 */
export async function setAvatarFromFile(file: File, instanceId?: string): Promise<string | null> {
  const img = await fileToSquareImage(file);
  if (!img) throw new Error("图片读取失败");
  const v = await setAssistantAvatar(img.mime, img.data, instanceId);
  if (instanceId) {
    instanceAvatars.delete(instanceId);
  } else {
    avatarUrl.value = v.dataUrl;
  }
  bumpInstanceAvatars();
  emitAvatarChanged(v.dataUrl);
  return v.dataUrl;
}

/** 恢复默认头像（✦）。`instanceId` 缺省 = active 实例。 */
export async function resetAvatar(instanceId?: string): Promise<string | null> {
  const v = await clearAssistantAvatar(instanceId);
  if (instanceId) {
    instanceAvatars.delete(instanceId);
  } else {
    avatarUrl.value = v.dataUrl;
  }
  bumpInstanceAvatars();
  emitAvatarChanged(v.dataUrl);
  return v.dataUrl;
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

/** 按实例的头像缓存（群聊/合并流按发送实例取头像；dataUrl，null = 默认 ✦）。 */
const instanceAvatars = new Map<string, string | null>();

/** 实例头像变更版本号：已挂载的展示组件（聊天气泡等）watch 它重拉，否则只在 mount 时取一次。 */
export const instanceAvatarsVersion = ref(0);

function bumpInstanceAvatars(): void {
  instanceAvatarsVersion.value++;
}

/** 拉取指定实例的头像（进程内缓存一次；离线/未知实例返回 null 用默认 ✦）。 */
export async function getInstanceAvatar(instanceId: string): Promise<string | null> {
  if (instanceAvatars.has(instanceId)) return instanceAvatars.get(instanceId) ?? null;
  let url: string | null = null;
  if (tauriAvailable()) {
    try {
      const v = await getAssistantAvatar(instanceId);
      url = v.dataUrl;
    } catch {
      /* 未知实例/离线：保持默认 */
    }
  }
  instanceAvatars.set(instanceId, url);
  return url;
}
