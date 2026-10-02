// TTS 源注入 + 自动/手动朗读（由 useSettings 提供开关与语音）。

import type { Ref } from "vue";
import type { ChatMessage } from "../../types";
import { speakMessageText } from "../../tts";
import type { TtsSpeakSpec } from "../../tts/queue";

/** TTS 源的声线：字符串 = 全局声线；对象 = 每实例音色覆盖。 */
export type TtsSourceVoice = string | TtsSpeakSpec;

export function createTtsBridge() {
  let ttsSource: (() => { enabled: boolean; voice: TtsSourceVoice } | null) | null = null;

  function setTtsSource(fn: () => { enabled: boolean; voice: TtsSourceVoice } | null): void {
    ttsSource = fn;
  }

  async function maybeSpeak(msg?: ChatMessage) {
    if (!msg || msg.kind !== "assistant" || msg.streaming) return;
    if (msg.fromHistory) return;
    // 群消息不自动朗读（产品定案）：群发言随成员会话流回，带 group 标的一律不读。
    if (msg.group) return;
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
