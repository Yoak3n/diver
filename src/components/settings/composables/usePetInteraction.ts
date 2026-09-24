// 桌宠互动感知设置（模式 + 调试参数）双写：sidecar settings + 壳端 ProactiveSpeak。

import { computed, ref, watch, type Ref } from "vue";
import type { PetInteractionSettings, SettingsInfo } from "../../../types";

const DEFAULT_INTERACTION: PetInteractionSettings = {
  mode: "events",
  quietMs: 10000,
  cooldownMs: 45000,
  maxTriggers: 1,
  longHoldMs: 3000,
};

export function usePetInteraction(settingsInfo: Ref<SettingsInfo | null>) {
  const interactionForm = ref<PetInteractionSettings>({ ...DEFAULT_INTERACTION });
  const interactionMode = computed(() => interactionForm.value.mode);

  watch(
    () => settingsInfo.value?.petInteraction,
    (v) => {
      if (v) interactionForm.value = { ...DEFAULT_INTERACTION, ...v };
    },
    { immediate: true, deep: true },
  );

  async function persistInteraction(patch: Partial<PetInteractionSettings>) {
    const next = { ...interactionForm.value, ...patch };
    interactionForm.value = next;
    try {
      const { saveSettings } = await import("../../../api");
      await saveSettings({ petInteraction: next });
    } catch (err) {
      console.error("[settings] save petInteraction failed", err);
    }
    try {
      const { tauriAvailable } = await import("../../../tauri");
      if (tauriAvailable()) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("set_pet_interaction_config", {
          config: {
            mode: next.mode,
            quietMs: next.quietMs,
            cooldownMs: next.cooldownMs,
            maxTriggers: next.maxTriggers,
            longHoldMs: next.longHoldMs,
          },
        });
      }
    } catch (err) {
      console.error("[settings] sync presence config failed", err);
    }
  }

  function onInteractionModeChange(mode: PetInteractionSettings["mode"]) {
    void persistInteraction({ mode });
  }

  function onInteractionNum(
    key: "quietMs" | "cooldownMs" | "maxTriggers" | "longHoldMs",
    raw: string,
  ) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    void persistInteraction({ [key]: Math.round(n) });
  }

  return {
    interactionForm,
    interactionMode,
    onInteractionModeChange,
    onInteractionNum,
  };
}
