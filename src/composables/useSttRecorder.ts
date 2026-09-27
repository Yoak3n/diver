// 语音输入状态机（STT 底座，拍板 2026-09-27：引擎后接）。
// 与 UI 解耦：组件只消费 state/seconds/level 与 toggle/cancel，
// 转写结果与用户提示经回调上抛（引擎契约见 src/stt/engine.ts）。

import { onBeforeUnmount, ref } from "vue";
import { currentSttEngine } from "../stt/engine";
import { MicRecorder } from "../stt/recorder";

export type SttState = "idle" | "recording" | "transcribing";

export function useSttRecorder(handlers: {
  /** 转写成功（文本已 trim，可能为空串=无有效语音）。 */
  onTranscribed: (text: string) => void;
  /** 面向用户的提示（权限失败/引擎未接入/转写失败）。 */
  onNotice: (message: string) => void;
}) {
  const state = ref<SttState>("idle");
  const seconds = ref(0);
  const level = ref(0);
  const recorder = new MicRecorder();
  let timer: number | null = null;
  let raf = 0;

  function onSttKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") cancel();
  }

  async function toggle() {
    if (state.value === "transcribing") return;
    if (state.value === "recording") {
      void finish();
      return;
    }
    try {
      await recorder.start();
    } catch (err) {
      handlers.onNotice(String((err as Error).message ?? err));
      return;
    }
    state.value = "recording";
    seconds.value = 0;
    timer = window.setInterval(() => {
      seconds.value += 1;
    }, 1000);
    const tick = () => {
      if (state.value !== "recording") return;
      level.value = recorder.level();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener("keydown", onSttKeydown);
  }

  async function finish() {
    stopTimers();
    const result = await recorder.stop();
    if (!result) {
      state.value = "idle";
      return;
    }
    const engine = currentSttEngine();
    if (!engine) {
      state.value = "idle";
      handlers.onNotice("语音引擎尚未接入：录音已丢弃（底座就绪，接入见 src/stt/engine.ts）");
      return;
    }
    state.value = "transcribing";
    try {
      const text = (
        await engine.transcribe({ blob: result.blob, mime: result.mime, durationMs: result.durationMs })
      ).trim();
      state.value = "idle";
      if (text) handlers.onTranscribed(text);
    } catch (err) {
      state.value = "idle";
      handlers.onNotice(`转写失败：${String((err as Error).message ?? err)}`);
    }
  }

  function cancel() {
    if (state.value !== "recording") return;
    stopTimers();
    recorder.cancel();
    state.value = "idle";
  }

  function stopTimers() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onSttKeydown);
  }

  onBeforeUnmount(() => {
    stopTimers();
    recorder.cancel();
  });

  return { state, seconds, level, toggle, cancel };
}
