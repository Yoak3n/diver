// 组合键录制（keydown 捕获 + 挂起全局热键）。

import { ref } from "vue";
import { resumeShortcuts, suspendShortcuts } from "../../../tauri";
import {
  eventToAccelerator,
  isCaptureCancel,
  isImeEvent,
  modifierHint,
} from "../../../hotkey";

export function useHotkeyCapture(opts: {
  onCaptured: (target: string, accel: string) => Promise<void> | void;
  onError: (msg: string) => void;
}) {
  /** null = 未录制；"__new__" = 新增表单；其余为绑定 id */
  const capturingId = ref<string | null>(null);
  const capturePreview = ref("");

  function detachCapture() {
    capturingId.value = null;
    capturePreview.value = "";
    window.removeEventListener("keydown", onCaptureKey, true);
  }

  function stopCapture() {
    detachCapture();
    void resumeShortcuts().catch((err: unknown) => {
      opts.onError(String(err));
    });
  }

  function startCapture(id: string) {
    detachCapture();
    capturingId.value = id;
    capturePreview.value = "";
    window.addEventListener("keydown", onCaptureKey, true);
    void suspendShortcuts().catch((err: unknown) => {
      opts.onError(`挂起全局快捷键失败（录制可能收不到按键）: ${err}`);
    });
  }

  function onCaptureKey(e: KeyboardEvent) {
    if (isImeEvent(e)) return;
    e.preventDefault();
    e.stopPropagation();

    if (isCaptureCancel(e)) {
      stopCapture();
      return;
    }

    const accel = eventToAccelerator(e);
    if (accel === null) {
      capturePreview.value = modifierHint(e);
      return;
    }

    const target = capturingId.value;
    detachCapture();
    if (target === null) {
      void resumeShortcuts().catch(() => {});
      return;
    }

    void (async () => {
      try {
        await opts.onCaptured(target, accel);
      } finally {
        void resumeShortcuts().catch((err: unknown) => {
          opts.onError(String(err));
        });
      }
    })();
  }

  function dispose() {
    detachCapture();
    void resumeShortcuts().catch(() => {});
  }

  return { capturingId, capturePreview, startCapture, stopCapture, dispose };
}
