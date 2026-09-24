// 桌宠模型挂载 / 切换 / 外部热更新。

import { ref } from "vue";
import { MODEL_HEIGHT_RATIO } from "../constants";
import type { PetModelHandle } from "../live2d";
import {
  loadModelCatalog,
  pickModelProfile,
  selectModelId,
  PET_MODEL_CHANGED_EVENT,
} from "../models";
import type { PetModelProfile } from "../models";

export function usePetModel(opts: {
  getPanelOpen: () => boolean;
  getBubbleSide: () => "left" | "right";
  getBubbleVisible: () => boolean;
  layoutSpeechBubble: () => void;
}) {
  const modelHost = ref<HTMLElement | null>(null);
  const loading = ref(true);
  const loadError = ref<string | null>(null);
  const modelProfiles = ref<PetModelProfile[]>([]);
  const activeModelId = ref<string>("");
  const modelPickerOpen = ref(false);
  const switchingModel = ref(false);

  let pet: PetModelHandle | null = null;

  function getPet() {
    return pet;
  }

  async function mountPetModel(profile: PetModelProfile) {
    if (!modelHost.value) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    if (!modelHost.value) {
      throw new Error("模型容器未就绪（modelHost 为空）");
    }
    pet?.destroy();
    pet = null;
    const mod = await import("../live2d");
    pet = await mod.createPetModel(modelHost.value, {
      heightRatio: profile.heightRatio ?? MODEL_HEIGHT_RATIO,
      anchorXRatio: 0.5,
      modelUrl: profile.model3,
      groupAliases: profile.groupAliases,
    });
    activeModelId.value = profile.id;
    if (opts.getPanelOpen()) pet.setRetreat(true, opts.getBubbleSide());
    if (opts.getBubbleVisible()) opts.layoutSpeechBubble();
  }

  async function switchModel(id: string) {
    if (switchingModel.value || id === activeModelId.value) {
      modelPickerOpen.value = false;
      return;
    }
    const profile = modelProfiles.value.find((m) => m.id === id);
    if (!profile) return;
    switchingModel.value = true;
    modelPickerOpen.value = false;
    loadError.value = null;
    try {
      await mountPetModel(profile);
      selectModelId(profile.id);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[pet] switch model failed:", detail, err);
      loadError.value =
        detail +
        (profile.installHint ? `（可先执行 ${profile.installHint}）` : "");
    } finally {
      switchingModel.value = false;
      loading.value = false;
    }
  }

  async function onExternalModelChange(id: string) {
    if (!id || id === activeModelId.value || switchingModel.value) return;
    const profile = modelProfiles.value.find((m) => m.id === id);
    if (!profile) return;
    switchingModel.value = true;
    loadError.value = null;
    try {
      await mountPetModel(profile);
    } catch (err) {
      loadError.value = err instanceof Error ? err.message : String(err);
    } finally {
      switchingModel.value = false;
      loading.value = false;
    }
  }

  function currentProfile(): PetModelProfile | undefined {
    return modelProfiles.value.find((m) => m.id === activeModelId.value);
  }

  async function initModel() {
    if (!modelHost.value) return;
    const catalog = await loadModelCatalog();
    modelProfiles.value = catalog.models;
    const profile = pickModelProfile(catalog);
    await mountPetModel(profile);
    loading.value = false;
  }

  function destroyPet() {
    pet?.destroy();
    pet = null;
  }

  return {
    modelHost,
    loading,
    loadError,
    modelProfiles,
    activeModelId,
    modelPickerOpen,
    switchingModel,
    getPet,
    mountPetModel,
    switchModel,
    onExternalModelChange,
    currentProfile,
    initModel,
    destroyPet,
  };
}

export { PET_MODEL_CHANGED_EVENT };
