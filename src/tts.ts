// 本地 TTS 朗读工具（Tauri SAPI / 浏览器 SpeechSynthesis 双模式）

import { speakText, tauriAvailable } from "./tauri";

/** 朗读一段文本（按运行环境选择通道）。 */
export async function speakMessageText(text: string, voice: string): Promise<void> {
  if (!text) return;
  if (tauriAvailable()) {
    await speakText(text, voice || undefined);
  } else {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    speechSynthesis.speak(u);
  }
}
