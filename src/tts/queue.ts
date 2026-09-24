// 朗读入口：入队到后端播放队列（latest-wins），由挂载的 pet/main 播放器出声。

import { invoke, tauriAvailable } from "../ipc";
import { claimSpeech } from "./spoken";

/**
 * 朗读入口（任意窗口调用）。
 * 队列与合成在后端；播放器挂载在 pet（优先）或 main。
 */
export async function speakMessageText(
  text: string,
  voice?: string,
  messageId?: string,
  opts?: { force?: boolean; userGesture?: boolean },
): Promise<void> {
  if (!text.trim() || !tauriAvailable()) return;
  if (!opts?.force && !opts?.userGesture && !claimSpeech(messageId, text)) return;
  await invoke("tts_speak", {
    text,
    voice: voice || null,
    force: !!(opts?.force || opts?.userGesture),
  });
}

/** 停止朗读：清队列并通知播放窗口。 */
export function stopSpeaking(_opts?: { broadcast?: boolean }): void {
  if (!tauriAvailable()) return;
  void invoke("tts_stop").catch(() => {});
}

export { claimSpeech };
