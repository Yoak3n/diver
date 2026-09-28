// 输入框语音输入（STT 底座，拍板 2026-09-27：引擎后接）。
// 点击开始/结束录音；结束 → 当前引擎转写 → 文本经 onAppend 追加进输入框。
// 状态机见 useSttRecorder；提示行计时收敛在此。

import { onBeforeUnmount, ref } from "vue";
import { useSttRecorder } from "./useSttRecorder";

export function useComposerStt(onAppend: (text: string) => void) {
  const sttNotice = ref<string | null>(null);
  let noticeTimer: number | null = null;

  const { state: sttState, seconds: sttSeconds, level: sttLevel, toggle: toggleStt, cancel: cancelStt } =
    useSttRecorder({
      onTranscribed: onAppend,
      onNotice: (message) => {
        sttNotice.value = message;
        if (noticeTimer !== null) clearTimeout(noticeTimer);
        noticeTimer = window.setTimeout(() => {
          sttNotice.value = null;
        }, 6000);
      },
    });

  function fmtStt(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  onBeforeUnmount(() => {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
  });

  return { sttNotice, sttState, sttSeconds, sttLevel, toggleStt, cancelStt, fmtStt };
}
