// 插件列表 / profile 切换 / 安装卸载 + sidecar 重启提示。

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

export function usePluginsTab() {
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

  function markRestartPending(message: string) {
    pendingRestartHint = true;
    hint.value = message;
  }

  function bindSidecarReadyTip() {
    if (!tauriAvailable() || stopSidecarListen) return;
    void onTauriEvent<SidecarStatus>("sidecar://status", (status) => {
      if (status.state !== "running" || !pendingRestartHint) return;
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
    loading.value = true;
    error.value = "";
    try {
      const res = await listPluginsApi();
      activeProfile.value = res.activeProfile;
      plugins.value = res.plugins;
      try {
        native.value = await getNativeStatusApi();
      } catch {
        native.value = null;
      }
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  async function onToggle(plugin: PluginInfo, enabled: boolean) {
    if (!plugin.toggleable) return;
    busyId.value = plugin.id;
    error.value = "";
    hint.value = "";
    try {
      const res = await togglePluginApi(plugin.id, enabled, true);
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
      const res = await switchProfileApi(profile, true);
      activeProfile.value = res.activeProfile;
      const list = await listPluginsApi();
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
      const res = await installProfilePluginApi(spec, true);
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
      const res = await uninstallProfilePluginApi(p.id, true);
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
    onToggle,
    onSwitchProfile,
    onInstall,
    onUninstall,
    dispose,
  };
}
