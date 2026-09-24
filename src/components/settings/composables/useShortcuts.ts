// 全局快捷键绑定 CRUD（热插拔）。

import { ref } from "vue";
import {
  listShortcuts,
  setShortcut,
  removeShortcut,
  tauriAvailable,
  type ShortcutAction,
  type ShortcutBinding,
} from "../../../tauri";

export function useShortcuts() {
  const bindings = ref<ShortcutBinding[]>([]);
  const loading = ref(false);
  const busyId = ref<string | null>(null);
  const error = ref("");
  const hint = ref("");
  const newAction = ref<ShortcutAction>("show-main");
  const newAccelerator = ref("");
  const adding = ref(false);

  async function refresh() {
    if (!tauriAvailable()) return;
    loading.value = true;
    error.value = "";
    try {
      bindings.value = await listShortcuts();
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  async function onToggle(binding: ShortcutBinding, enabled: boolean) {
    if (busyId.value) return;
    busyId.value = binding.id;
    error.value = "";
    hint.value = "";
    try {
      const next = { ...binding, enabled };
      bindings.value = await setShortcut(next);
      hint.value = enabled
        ? `已注册 ${binding.accelerator}（立即生效）`
        : `已注销 ${binding.accelerator}（绑定保留）`;
    } catch (e) {
      error.value = String(e);
      await refresh().catch(() => {});
    } finally {
      busyId.value = null;
    }
  }

  async function onSaveAccelerator(binding: ShortcutBinding, accelerator: string) {
    const accel = accelerator.trim();
    if (!accel) return;
    if (accel === binding.accelerator) {
      hint.value = `组合键未变化（仍为 ${accel}）`;
      return;
    }
    if (busyId.value) return;
    busyId.value = binding.id;
    error.value = "";
    hint.value = "";
    const optimistic = bindings.value.map((b) =>
      b.id === binding.id ? { ...b, accelerator: accel } : b,
    );
    bindings.value = optimistic;
    try {
      const next = { ...binding, accelerator: accel };
      bindings.value = await setShortcut(next);
      hint.value = `已更新为 ${accel}（立即生效）`;
    } catch (e) {
      error.value = String(e);
      await refresh().catch(() => {});
    } finally {
      busyId.value = null;
    }
  }

  async function onRemove(binding: ShortcutBinding) {
    if (busyId.value) return;
    busyId.value = binding.id;
    error.value = "";
    hint.value = "";
    try {
      bindings.value = await removeShortcut(binding.id);
      hint.value = `已移除 ${binding.accelerator}`;
    } catch (e) {
      error.value = String(e);
      await refresh().catch(() => {});
    } finally {
      busyId.value = null;
    }
  }

  async function onAdd() {
    const accel = newAccelerator.value.trim();
    if (!accel || adding.value) return;
    adding.value = true;
    error.value = "";
    hint.value = "";
    try {
      const binding: ShortcutBinding = {
        id: `custom-${Date.now().toString(36)}`,
        accelerator: accel,
        action: newAction.value,
        enabled: true,
      };
      bindings.value = await setShortcut(binding);
      newAccelerator.value = "";
      hint.value = `已注册 ${accel}（立即生效）`;
    } catch (e) {
      error.value = String(e);
      await refresh().catch(() => {});
    } finally {
      adding.value = false;
    }
  }

  return {
    bindings,
    loading,
    busyId,
    error,
    hint,
    newAction,
    newAccelerator,
    adding,
    refresh,
    onToggle,
    onSaveAccelerator,
    onRemove,
    onAdd,
  };
}
