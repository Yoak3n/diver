// 设置「插件」页的实例作用域：实例清单 + 运行态 + 当前选择。
//
// 每个实例有独立的 COS_HOME / profile 补丁 / 插件目录，插件启停与配置必须按
// 实例寻址。非 Tauri（纯浏览器预览）没有实例概念，回落 active 实例。

import { computed, ref } from "vue";
import { refreshInstanceRuntimes } from "../../../api";
import { useInstances } from "../../../composables/useInstances";
import { onTauriEvent, tauriAvailable } from "../../../tauri";
import type { SidecarStatus } from "../../../types";

export function usePluginScope() {
  const { instances, error, refresh: refreshInstances } = useInstances();
  const selectedId = ref("");
  const runningIds = ref<Set<string>>(new Set());
  const scopeLoading = ref(false);
  const isTauri = tauriAvailable();
  let stopStatusListen: (() => void) | null = null;

  const selectedInstance = computed(
    () => instances.value.find((i) => i.id === selectedId.value) ?? null,
  );

  /** API 寻址目标；undefined = active 实例（非 Tauri 环境）。 */
  const targetInstanceId = computed(() =>
    isTauri && selectedId.value ? selectedId.value : undefined,
  );

  /** 未运行实例的 backend 不可达，插件面不能读写。 */
  const canManage = computed(
    () => !isTauri || (!!selectedId.value && runningIds.value.has(selectedId.value)),
  );

  async function refreshRunning(): Promise<void> {
    if (!isTauri) return;
    try {
      const rows = await refreshInstanceRuntimes();
      runningIds.value = new Set(rows.map((r) => r.id));
    } catch {
      runningIds.value = new Set();
    }
  }

  /** sidecar 状态全实例广播：运行态跟二进制走，不靠住页面时的快照。 */
  function bindStatus() {
    if (!isTauri || stopStatusListen) return;
    void onTauriEvent<SidecarStatus>("sidecar://status", (status) => {
      // 重启会先发 stopped 再 starting；期间保持可管理，避免把重启提示清掉。
      if (status.state === "running") {
        const next = new Set(runningIds.value);
        next.add(status.id);
        runningIds.value = next;
      } else if (status.state === "crashed") {
        const next = new Set(runningIds.value);
        next.delete(status.id);
        runningIds.value = next;
      }
    }).then((unlisten) => {
      stopStatusListen = unlisten;
    });
  }

  async function load(): Promise<void> {
    if (!isTauri) return;
    scopeLoading.value = true;
    try {
      await refreshInstances();
      await refreshRunning();
      if (!instances.value.some((i) => i.id === selectedId.value)) {
        const first = instances.value.find((i) => i.enabled) ?? instances.value[0];
        selectedId.value = first?.id ?? "";
      }
    } finally {
      scopeLoading.value = false;
    }
  }

  function dispose() {
    stopStatusListen?.();
    stopStatusListen = null;
  }

  return {
    instances,
    error,
    selectedId,
    selectedInstance,
    runningIds,
    scopeLoading,
    isTauri,
    targetInstanceId,
    canManage,
    load,
    refreshRunning,
    bindStatus,
    dispose,
  };
}
