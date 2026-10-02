// 朗读入口：入队到后端播放队列（latest-wins），由挂载的 pet/main 播放器出声。

import { invoke, tauriAvailable } from "../ipc";
import { claimSpeech } from "./spoken";

/**
 * 每实例音色覆盖（未给的项跟随全局 TTS 配置）。
 * 字符串形式的 `voice` 参数 = 仅指定全局声线的旧用法。
 */
export interface TtsSpeakSpec {
  provider?: string;
  model?: string;
  voice: string;
  speed?: number;
  styleInstruction?: string;
}

/**
 * 朗读入口（任意窗口调用）。
 * 队列与合成在后端；播放器挂载在 pet（优先）或 main。
 * `voice`：字符串 = 全局声线；`TtsSpeakSpec` = 每实例音色（凭据按提供商分槽解析）。
 */
export async function speakMessageText(
  text: string,
  voice?: string | TtsSpeakSpec,
  messageId?: string,
  opts?: { force?: boolean; userGesture?: boolean },
): Promise<void> {
  if (!text.trim() || !tauriAvailable()) return;
  if (!opts?.force && !opts?.userGesture && !claimSpeech(messageId, text)) return;
  const spec = typeof voice === "object" && voice ? voice : undefined;
  const plain = typeof voice === "string" ? voice : spec?.voice;
  await invoke("tts_speak", {
    text,
    voice: plain || null,
    force: !!(opts?.force || opts?.userGesture),
    tts: spec ?? null,
    // 跨窗口去重键：主窗/桌宠同开时同一条消息两边都会触发自动朗读，
    // 本地 spoken map 按 WebView 隔离挡不住，权威认领在共享播放队列。
    messageId: messageId ?? null,
  });
}

/** 停止朗读：清队列并通知播放窗口。 */
export function stopSpeaking(_opts?: { broadcast?: boolean }): void {
  if (!tauriAvailable()) return;
  void invoke("tts_stop").catch(() => {});
}

/** 实例音色档案 → 朗读 spec；`null` = 跟随全局声线（调用方给字符串即可）。 */
export function ttsSpeakSpecOf(profile: {
  provider: string;
  model: string;
  voice: string;
  speed: number;
  styleInstruction: string;
} | null): TtsSpeakSpec | null {
  return profile
    ? {
        provider: profile.provider,
        model: profile.model,
        voice: profile.voice,
        speed: profile.speed,
        styleInstruction: profile.styleInstruction,
      }
    : null;
}

export { claimSpeech };
