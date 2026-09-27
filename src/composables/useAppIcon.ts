// 应用图标共享状态（应用级品牌位，窗口标题栏等）：模块级单例，跨窗口事件同步。

import { ref } from "vue";
import {
  clearAppIcon,
  emitAppIconChanged,
  getAppIcon,
  onAppIconChanged,
  setAppIcon,
} from "../ipc/avatar";
import { fileToSquareImage } from "../imageAttach";
import { tauriAvailable } from "../tauri";

const appIconUrl = ref<string | null>(null);
const appIconPath = ref("");
let loaded = false;
let unlisten: (() => void) | null = null;

async function ensureListener(): Promise<void> {
  if (unlisten || !tauriAvailable()) return;
  unlisten = await onAppIconChanged((dataUrl) => {
    appIconUrl.value = dataUrl;
  });
}

/** 拉取应用图标（默认只拉一次；force=强制重读磁盘）。 */
async function loadAppIcon(force = false): Promise<void> {
  if (!tauriAvailable()) return;
  if (loaded && !force) return;
  await ensureListener();
  try {
    const v = await getAppIcon();
    appIconUrl.value = v.dataUrl;
    appIconPath.value = v.path ?? "";
    loaded = true;
  } catch {
    /* 离线/非 Tauri：保持默认 */
  }
}

/** 从 File 设置应用图标（中心方裁 + 缩到 256×256 后写入壳层）。 */
export async function setAppIconFromFile(file: File): Promise<string | null> {
  const img = await fileToSquareImage(file);
  if (!img) throw new Error("图片读取失败");
  const v = await setAppIcon(img.mime, img.data);
  appIconUrl.value = v.dataUrl;
  emitAppIconChanged(v.dataUrl);
  return v.dataUrl;
}

/** 恢复默认应用图标（✦）。 */
export async function resetAppIcon(): Promise<string | null> {
  const v = await clearAppIcon();
  appIconUrl.value = v.dataUrl;
  emitAppIconChanged(v.dataUrl);
  return v.dataUrl;
}

/** 品牌位展示处使用：null 时渲染默认 ✦。 */
export function useAppIcon() {
  return {
    appIconUrl,
    appIconPath,
    loadAppIcon,
    setAppIconFromFile,
    resetAppIcon,
  };
}
