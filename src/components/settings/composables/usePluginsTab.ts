// 插件列表 / profile 切换 / 安装卸载 + sidecar 重启提示。
// 多实例：所有读写按 instanceId getter 寻址到所选实例的 backend；
// 未运行实例的 backend 不可达，调用方用 canManage 拦住、不要发起请求。

import { ref } from "vue";
import {
  listPluginsApi,
  togglePluginApi,
  switchProfileApi,
  installProfilePluginApi,
  uninstallProfilePluginApi,
  getNativeStatusApi,
  type PluginInfo,
  type NativeStatus,
} from "../../../api";
import { onTauriEvent, tauriAvailable } from "../../../tauri";
import type { SidecarStatus } from "../../../types";

/** 当前作用域实例；undefined = 非 Tauri / 单实例，走 active 实例。 */
type InstanceTarget = () => string | undefined;

export function usePluginsTab(instanceId?: InstanceTarget) {
  const plugins = ref<PluginInfo[]>([]);
  const loading = ref(false);
  const busyId = ref<string | null>(null);
  const error = ref("");
  const hint = ref("");
  const activeProfile = ref("companion");
  const native = ref<NativeStatus | null>(null);
  const profileBusy = ref(false);
  const installSpec = ref("");
  const installBusy = ref(false);

  let pendingRestartHint = false;
  let stopSidecarListen: (() => void) | null = null;
  let refreshSeq = 0;

  function target(): string | undefined {
    return instanceId?.();
  }

  function markRestartPending(message: string) {
    pendingRestartHint = true;
    hint.value = message;
  }

  function bindSidecarReadyTip() {
    if (!tauriAvailable() || stopSidecarListen) return;
    void onTauriEvent<SidecarStatus>("sidecar://status", (status) => {
      if (status.state !== "running" || !pendingRestartHint) return;
      // 事件全实例广播：只认当前作用域实例的重启结果。
      if (target() !== undefined && status.id !== target()) return;
      pendingRestartHint = false;
      hint.value = hint.value
        .replace(/sidecar 正在重启…/, "sidecar 已重启成功")
        .replace(/sidecar 重启中…/, "sidecar 已重启成功");
      void refresh();
    }).then((unlisten) => {
      stopSidecarListen = unlisten;
    });
  }

  async function refresh() {
    const seq = ++refreshSeq;
    loading.value = true;
    error.value = "";
    try {
      const res = await listPluginsApi(target());
      if (seq !== refreshSeq) return;
      activeProfile.value = res.activeProfile;
      plugins.value = res.plugins;
      try {
        const status = await getNativeStatusApi(target());
        if (seq === refreshSeq) native.value = status;
      } catch {
        if (seq === refreshSeq) native.value = null;
      }
    } catch (e) {
      if (seq !== refreshSeq) return;
      plugins.value = [];
      native.value = null;
      error.value = String(e);
    } finally {
      if (seq === refreshSeq) loading.value = false;
    }
  }

  /** 切到一个不可达实例时清空上一次实例的残留状态。 */
  function reset() {
    refreshSeq++;
    plugins.value = [];
    native.value = null;
    loading.value = false;
    error.value = "";
    hint.value = "";
    pendingRestartHint = false;
  }

  /** 切实例时清掉上一实例的重启提示，避免把 A 的重启结果带到 B。 */
  function clearHint() {
    pendingRestartHint = false;
    hint.value = "";
  }

  async function onToggle(plugin: PluginInfo, enabled: boolean) {
    if (!plugin.toggleable) return;
    busyId.value = plugin.id;
    error.value = "";
    hint.value = "";
    try {
      const res = await togglePluginApi(plugin.id, enabled, true, target());
      plugins.value = res.plugins;
      activeProfile.value = res.activeProfile;
      markRestartPending(
        enabled
          ? `已启用「${plugin.displayName}」，sidecar 正在重启…`
          : `已禁用「${plugin.displayName}」，sidecar 正在重启…`,
      );
    } catch (e) {
      error.value = String(e);
      await refresh();
    } finally {
      busyId.value = null;
    }
  }

  async function onSwitchProfile(profile: "companion" | "safe") {
    if (profileBusy.value) return;
    if (activeProfile.value === profile) return;
    profileBusy.value = true;
    error.value = "";
    hint.value = "";
    try {
      const res = await switchProfileApi(profile, true, target());
      activeProfile.value = res.activeProfile;
      const list = await listPluginsApi(target());
      plugins.value = list.plugins;
      markRestartPending(
        profile === "safe"
          ? "已切换安全模式（核心 + 后端），sidecar 正在重启…"
          : "已切回 companion 完整组合，sidecar 正在重启…",
      );
    } catch (e) {
      error.value = String(e);
      await refresh();
    } finally {
      profileBusy.value = false;
    }
  }

  async function onInstall() {
    const spec = installSpec.value.trim();
    if (!spec || installBusy.value) return;
    installBusy.value = true;
    error.value = "";
    hint.value = "";
    try {
      const res = await installProfilePluginApi(spec, true, target());
      plugins.value = res.plugins;
      markRestartPending(`已安装 ${spec}，sidecar 正在重启…`);
      installSpec.value = "";
    } catch (e) {
      error.value = String(e);
    } finally {
      installBusy.value = false;
      await refresh().catch(() => {});
    }
  }

  async function onUninstall(p: PluginInfo) {
    if (p.kind !== "profile") return;
    busyId.value = p.id;
    error.value = "";
    hint.value = "";
    try {
      const res = await uninstallProfilePluginApi(p.id, true, target());
      plugins.value = res.plugins;
      markRestartPending(`已卸载 ${p.packageName}，sidecar 正在重启…`);
    } catch (e) {
      error.value = String(e);
    } finally {
      busyId.value = null;
      await refresh().catch(() => {});
    }
  }

  function dispose() {
    stopSidecarListen?.();
    stopSidecarListen = null;
  }

  return {
    plugins,
    loading,
    busyId,
    error,
    hint,
    activeProfile,
    native,
    profileBusy,
    installSpec,
    installBusy,
    bindSidecarReadyTip,
    refresh,
    reset,
    clearHint,
    onToggle,
    onSwitchProfile,
    onInstall,
    onUninstall,
    dispose,
  };
}
