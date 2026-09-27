// 桌宠启动/销毁生命周期装配。

import { onBeforeUnmount, onMounted } from "vue";
import { loadEmotionMap } from "../emotion";
import { onTauriEvent } from "../../tauri";
import { PET_MODEL_CHANGED_EVENT } from "../models";

type Deps = {
  connect: () => void;
  startAutoRefresh: () => void;
  updateBubbleSide: () => Promise<void>;
  bindPetMovedListener: () => Promise<void>;
  initInteractionHold: () => Promise<void>;
  startSideTimer: () => void;
  startClickthrough: () => Promise<void>;
  bindTts: () => void;
  initModel: () => Promise<void>;
  onExternalModelChange: (id: string, instanceId?: string) => Promise<void>;
  setMapReady: () => void;
  onModelError: (err: unknown) => void;
  disposePanel: () => void;
  disposeDrag: () => void;
  stopClickthrough: () => void;
  disposeLip: () => void;
  destroyPet: () => void;
  hideBubble: () => void;
};

export function usePetLifecycle(deps: Deps) {
  let unlistenModelChanged: (() => void) | null = null;
  const onStorage = (e: StorageEvent) => {
    if (e.key === "diver.pet.modelId" && e.newValue) {
      void deps.onExternalModelChange(e.newValue);
    }
  };

  onMounted(async () => {
    deps.connect();
    deps.startAutoRefresh();
    void deps.updateBubbleSide();
    void deps.bindPetMovedListener();
    void deps.initInteractionHold();
    deps.startSideTimer();
    void deps.startClickthrough();
    deps.bindTts();
    // 模型换装监听先挂、加载后置：Live2D 核心 + 模型文件要几秒，这段里到达的
    // 换装请求（设置页刚改完、桌宠窗刚起）没队列缓冲就会静默丢失，窗口留在旧模型。
    // 队列用对象持有：回调里的赋值不被控制流分析当作「读点仍是 null」。
    const pendingChange: { value: { id: string; instanceId?: string } | null } = { value: null };
    let modelReady = false;
    unlistenModelChanged = await onTauriEvent<{ id: string; instanceId?: string }>(
      PET_MODEL_CHANGED_EVENT,
      (p) => {
        if (!p?.id) return;
        if (!modelReady) {
          pendingChange.value = p;
          return;
        }
        void deps.onExternalModelChange(p.id, p.instanceId ?? undefined);
      },
    );
    try {
      await deps.initModel();
      try {
        await loadEmotionMap();
      } finally {
        deps.setMapReady();
      }
    } catch (err) {
      deps.onModelError(err);
    } finally {
      // 与加载成败无关：失败也要能换装/重试，先把启动期攒下的那次补放。
      modelReady = true;
      const queued = pendingChange.value;
      pendingChange.value = null;
      if (queued) void deps.onExternalModelChange(queued.id, queued.instanceId);
      window.addEventListener("storage", onStorage);
    }
  });

  onBeforeUnmount(() => {
    unlistenModelChanged?.();
    window.removeEventListener("storage", onStorage);
    deps.disposePanel();
    deps.disposeDrag();
    deps.stopClickthrough();
    deps.disposeLip();
    deps.destroyPet();
    deps.hideBubble();
  });
}
