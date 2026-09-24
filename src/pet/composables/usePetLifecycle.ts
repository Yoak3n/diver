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
  onExternalModelChange: (id: string) => Promise<void>;
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
  onMounted(async () => {
    deps.connect();
    deps.startAutoRefresh();
    void deps.updateBubbleSide();
    void deps.bindPetMovedListener();
    void deps.initInteractionHold();
    deps.startSideTimer();
    void deps.startClickthrough();
    deps.bindTts();
    try {
      await deps.initModel();
      try {
        await loadEmotionMap();
      } finally {
        deps.setMapReady();
      }
      void onTauriEvent<{ id: string }>(PET_MODEL_CHANGED_EVENT, (p) => {
        void deps.onExternalModelChange(p?.id);
      });
      window.addEventListener("storage", (e) => {
        if (e.key === "diver.pet.modelId" && e.newValue) {
          void deps.onExternalModelChange(e.newValue);
        }
      });
    } catch (err) {
      deps.onModelError(err);
    }
  });

  onBeforeUnmount(() => {
    deps.disposePanel();
    deps.disposeDrag();
    deps.stopClickthrough();
    deps.disposeLip();
    deps.destroyPet();
    deps.hideBubble();
  });
}
