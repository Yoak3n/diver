// 群头像共享状态：按群 id 缓存 dataUrl + 版本号驱动展示组件重拉。
// 群头像只在主窗口展示（侧栏群行 / 群管理面板），无需跨窗口事件。

import { ref } from "vue";
import { clearGroupAvatar, getGroupAvatar, setGroupAvatar } from "../ipc/avatar";
import { fileToSquareImage } from "../imageAttach";
import { tauriAvailable } from "../tauri";

const cache = new Map<string, string | null>();

/** 群头像变更版本号：已挂载的展示组件 watch 它重拉。 */
export const groupAvatarsVersion = ref(0);

/** 拉取指定群头像（进程内缓存；未设置/离线返回 null → 首字渐变块）。 */
export async function getGroupAvatarUrl(groupId: string): Promise<string | null> {
  if (cache.has(groupId)) return cache.get(groupId) ?? null;
  let url: string | null = null;
  if (tauriAvailable()) {
    try {
      const v = await getGroupAvatar(groupId);
      url = v.dataUrl;
    } catch {
      /* 未知群/离线：保持默认 */
    }
  }
  cache.set(groupId, url);
  return url;
}

/** 从 File 设置群头像（中心方裁 + 缩到 256×256 后写入壳层）。 */
export async function setGroupAvatarFromFile(groupId: string, file: File): Promise<string | null> {
  const img = await fileToSquareImage(file);
  if (!img) throw new Error("图片读取失败");
  const v = await setGroupAvatar(groupId, img.mime, img.data);
  cache.set(groupId, v.dataUrl);
  groupAvatarsVersion.value++;
  return v.dataUrl;
}

/** 恢复默认群头像（首字渐变块）。 */
export async function resetGroupAvatar(groupId: string): Promise<string | null> {
  const v = await clearGroupAvatar(groupId);
  cache.set(groupId, v.dataUrl);
  groupAvatarsVersion.value++;
  return v.dataUrl;
}
