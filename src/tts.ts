// 在线 TTS 朗读：壳层 Rust 合成 → WebView `<audio>` 播放（无本地 SAPI）。

import { synthesizeTts, tauriAvailable } from "./tauri";

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

function stopCurrent() {
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * 朗读一段文本（在线 TTS）。
 * Promise 在音频播放结束时 resolve，便于桌宠口型对齐真实时长。
 */
export async function speakMessageText(text: string, voice?: string): Promise<void> {
  if (!text.trim() || !tauriAvailable()) return;
  stopCurrent();
  const audio = await synthesizeTts(text, voice || undefined);
  const blob = base64ToBlob(audio.base64, audio.mime);
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  currentAudio = el;
  currentUrl = url;
  await new Promise<void>((resolve) => {
    el.onended = () => {
      stopCurrent();
      resolve();
    };
    el.onerror = () => {
      stopCurrent();
      resolve();
    };
    el.play().catch(() => {
      stopCurrent();
      resolve();
    });
  });
}

/** 中断当前朗读。 */
export function stopSpeaking(): void {
  stopCurrent();
}
