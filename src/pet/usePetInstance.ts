// P2-5 多桌宠：桌宠窗口的实例绑定（URL ?instance=）与元数据。
//
// 窗口 URL 形如 `/#/pet?instance=beta`（hash 路由：query 在 hash 里，不在 location.search）。
// 经典单例桌宠不带参数 = 跟随 active 实例（行为不变）；实例桌宠钉定创建时的实例。

import { ref } from "vue";
import { listInstances, type InstanceTtsProfile } from "../ipc/instances";
import { setInstancePetModel as setPetModelIpc } from "../ipc/petInstances";

/** 从 URL hash 解析绑定实例（`#/pet?instance=<id>`）；无参数 = null（跟随 active）。 */
export function petInstanceFromHash(hash: string): string | null {
  const q = hash.split("?")[1] ?? "";
  for (const pair of q.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    if (pair.slice(0, eq) === "instance") {
      const v = decodeURIComponent(pair.slice(eq + 1));
      if (v) return v;
    }
  }
  return null;
}

export function usePetInstance() {
  const instanceId = ref<string | null>(petInstanceFromHash(window.location.hash));
  const petModelId = ref<string | null>(null);
  /** 每实例自动朗读（缺省 true；经典宠无实例绑定，保持 true 跟随全局语义）。 */
  const autoRead = ref(true);
  /** 每实例音色档案（null = 跟随全局 TTS 配置）。 */
  const ttsProfile = ref<InstanceTtsProfile | null>(null);

  /** 拉元数据：每实例模型（null = 跟随全局）。可重复调用（定向换装后重读）。 */
  async function loadMeta(): Promise<void> {
    if (!instanceId.value) return;
    try {
      const rows = await listInstances();
      const m = rows.find((r) => r.id === instanceId.value);
      petModelId.value = m?.petModel ?? null;
      autoRead.value = m?.autoRead ?? true;
      ttsProfile.value = m?.tts ?? null;
    } catch {
      /* 清单不可得：按未钉定处理（跟随全局） */
    }
  }

  /**
   * 首次元数据（单飞）。
   *
   * 模型解析必须先等它：冷启动时 `petModelId` 还是 null，而 null 的语义是
   * 「跟随全局」——不等就会把钉定模型当成跟随全局，实例宠一律起全局模型。
   */
  let initialMeta: Promise<void> | null = null;
  function ready(): Promise<void> {
    initialMeta ??= loadMeta();
    return initialMeta;
  }

  /** 在本宠的模型面板里换装 = 只改这个实例的模型。 */
  async function setPetModel(modelId: string): Promise<void> {
    if (!instanceId.value) return;
    petModelId.value = modelId;
    try {
      await setPetModelIpc(instanceId.value, modelId);
    } catch (err) {
      console.error("[pet] 每实例模型持久化失败:", err);
    }
  }

  return { instanceId, petModelId, autoRead, ttsProfile, ready, loadMeta, setPetModel };
}
