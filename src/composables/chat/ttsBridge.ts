// TTS 源注入 + 自动/手动朗读（由 useSettings 提供开关与语音）。

import type { Ref } from "vue";
import type { ChatMessage } from "../../types";
import { speakMessageText } from "../../tts";

export function createTtsBridge() {
  let ttsSource: (() => { enabled: boolean; voice: string } | null) | null = null;

  function setTtsSource(fn: () => { enabled: boolean; voice: string } | null): void {
    ttsSource = fn;
  }

  async function maybeSpeak(msg?: ChatMessage) {
    if (!msg || msg.kind !== "assistant" || msg.streaming) return;
    if (msg.fromHistory) return;
    const tts = ttsSource?.();
    if (!tts?.enabled || !msg.content.trim()) return;
    try {
      await speakMessageText(msg.content, tts.voice, msg.id);
    } catch {
      /* TTS 不可用时不打扰 */
    }
  }

  async function speakMessage(msg: ChatMessage) {
    const tts = ttsSource?.();
    await speakMessageText(msg.content, tts?.voice ?? "", msg.id, { force: true, userGesture: true });
  }

  return { setTtsSource, maybeSpeak, speakMessage };
}

/** attachments 辅助（预览 URL 生命周期）。 */
export function createAttachmentOps(attachments: Ref<{ id: string; previewUrl: string }[]>) {
  function addAttachments<T extends { id: string; previewUrl: string }>(items: T[]) {
    for (const item of items) {
      if (attachments.value.length >= 8) break;
      attachments.value.push(item);
    }
  }

  function removeAttachment(id: string) {
    const idx = attachments.value.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const [gone] = attachments.value.splice(idx, 1);
    try {
      URL.revokeObjectURL(gone.previewUrl);
    } catch {
      /* 忽略 */
    }
  }

  function clearAttachments() {
    for (const a of attachments.value) {
      try {
        URL.revokeObjectURL(a.previewUrl);
      } catch {
        /* 忽略 */
      }
    }
    attachments.value = [];
  }

  return { addAttachments, removeAttachment, clearAttachments };
}
