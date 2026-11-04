// 实例清单 / 归属 / 运行态：包装产品层 useInstances，向插件只暴露窄面。

import { computed, ref } from "vue";
import { refreshInstanceRuntimes } from "../../api";
import { useInstances } from "../../composables/useInstances";
import type { InstanceRow, InstanceService } from "../types";

export function createInstanceService(): InstanceService {
  const { instances, onebotOwner, notice, error, refresh, setQqOwner } =
    useInstances();
  const runningIds = ref<ReadonlySet<string>>(new Set());

  const rows = computed<readonly InstanceRow[]>(() =>
    instances.value.map((item) => ({
      id: item.id,
      name: item.name,
      enabled: item.enabled,
    })),
  );

  async function refreshAll(): Promise<void> {
    await refresh();
    try {
      const list = await refreshInstanceRuntimes();
      runningIds.value = new Set(list.map((row) => row.id));
    } catch {
      runningIds.value = new Set();
    }
  }

  async function setOnebotOwner(id: string | null): Promise<void> {
    if (id === null) {
      const current = onebotOwner.value;
      if (current !== null) await setQqOwner(current, false);
      return;
    }
    await setQqOwner(id, true);
  }

  return {
    rows,
    onebotOwner,
    runningIds,
    notice,
    error,
    refresh: refreshAll,
    setOnebotOwner,
  };
}
