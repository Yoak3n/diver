// 桌宠形象选择（catalog + 跨窗口热切换同步）。

import { computed, onMounted, ref } from "vue";
import { onTauriEvent } from "../../../tauri";
import {
  loadModelCatalog,
  pickModelProfile,
  selectModelId,
  PET_MODEL_CHANGED_EVENT,
} from "../../../pet/models";
import type { PetModelProfile } from "../../../pet/models";

export function usePetModelSelect() {
  const petModels = ref<PetModelProfile[]>([]);
  const activePetModelId = ref("");
  const petModelSwitching = ref(false);
  const petModelMsg = ref<string | null>(null);

  const activePetModelLabel = computed(
    () => petModels.value.find((m) => m.id === activePetModelId.value)?.label ?? "—",
  );

  async function refreshPetModels() {
    const catalog = await loadModelCatalog();
    petModels.value = catalog.models;
    activePetModelId.value = pickModelProfile(catalog).id;
  }

  function onPickPetModel(id: string) {
    if (petModelSwitching.value || id === activePetModelId.value) return;
    petModelSwitching.value = true;
    petModelMsg.value = null;
    try {
      selectModelId(id);
      activePetModelId.value = id;
      petModelMsg.value = "已切换；桌宠窗口会立即换装（未打开则下次启动生效）";
    } catch (err) {
      petModelMsg.value = err instanceof Error ? err.message : String(err);
    } finally {
      petModelSwitching.value = false;
    }
  }

  onMounted(async () => {
    try {
      await refreshPetModels();
    } catch (err) {
      petModelMsg.value = err instanceof Error ? err.message : String(err);
    }
    void onTauriEvent<{ id: string }>(PET_MODEL_CHANGED_EVENT, (p) => {
      if (p?.id) activePetModelId.value = p.id;
    });
    window.addEventListener("storage", (e) => {
      if (e.key === "diver.pet.modelId" && e.newValue) {
        activePetModelId.value = e.newValue;
      }
    });
  });

  return {
    petModels,
    activePetModelId,
    petModelSwitching,
    petModelMsg,
    activePetModelLabel,
    onPickPetModel,
  };
}
