// 设置页「实例」页的桌宠槽逻辑：召唤/收起（同屏上限 3 只）+ 每实例模型选择。
// 状态与动作一处收口，组件只做装配与展示。
import { ref } from "vue";
import type { InstanceMeta } from "../tauri";
import {
  closeInstancePet,
  listInstancePets,
  openInstancePet,
  setInstancePetModel,
} from "../ipc/petInstances";
import {
  loadGlobalModelId,
  loadModelCatalog,
  notifyModelChanged,
  type PetModelProfile,
} from "../pet/models";

export function useInstancePet() {
  const pets = ref<string[]>([]);
  const petBusy = ref("");
  const petMsg = ref("");
  const modelProfiles = ref<PetModelProfile[]>([]);
  const defaultModelId = ref("");

  async function loadCatalog(): Promise<void> {
    const cat = await loadModelCatalog();
    modelProfiles.value = cat.models;
    defaultModelId.value = cat.defaultModelId;
  }

  async function refreshPets(): Promise<void> {
    try {
      pets.value = await listInstancePets();
    } catch {
      pets.value = [];
    }
  }

  function petOn(inst: InstanceMeta): boolean {
    return pets.value.includes(inst.id);
  }

  async function togglePet(inst: InstanceMeta): Promise<void> {
    petBusy.value = inst.id;
    petMsg.value = "";
    try {
      pets.value = petOn(inst)
        ? await closeInstancePet(inst.id)
        : await openInstancePet(inst.id);
      petMsg.value = petOn(inst)
        ? `已召唤 ${inst.name || inst.id} 的桌宠（点谁互动谁）。`
        : "已收起。";
    } catch (err) {
      petMsg.value = err instanceof Error ? err.message : String(err);
    } finally {
      petBusy.value = "";
      void refreshPets();
    }
  }

  /** 每实例模型槽：空 = 跟随全局；选定 = 该实例钉定。落盘后定向通知在屏桌宠即时换装。 */
  async function onModelChange(inst: InstanceMeta, slot: string): Promise<void> {
    const model = slot || null;
    petMsg.value = "";
    try {
      await setInstancePetModel(inst.id, model);
      inst.petModel = model;
      const effective = model ?? (await loadGlobalModelId()) ?? defaultModelId.value;
      notifyModelChanged(effective, inst.id);
      petMsg.value = model
        ? `${inst.name || inst.id} 的桌宠模型已固定。`
        : `${inst.name || inst.id} 的桌宠改回跟随全局模型。`;
    } catch (err) {
      petMsg.value = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    pets,
    petBusy,
    petMsg,
    modelProfiles,
    loadCatalog,
    refreshPets,
    petOn,
    togglePet,
    onModelChange,
  };
}
