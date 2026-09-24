// 在线 TTS 相关 IPC（配置读写 / 声线 / 合成）。

import type { TtsAudio, TtsConfigPatch, TtsConfigView, TtsVoice } from "../types";
import { invoke } from "./core";

/** 读取在线 TTS 配置（secret 只回 has_*）。 */
export function getTtsConfig(): Promise<TtsConfigView> {
  return invoke<TtsConfigView>("get_tts_config");
}

/** 保存在线 TTS 配置（secret 空串 = 留空不改）。 */
export function setTtsConfig(config: TtsConfigPatch): Promise<TtsConfigView> {
  return invoke<TtsConfigView>("set_tts_config", { config });
}

/** 列出服务商声线。 */
export function listTtsVoices(provider?: string): Promise<TtsVoice[]> {
  return invoke<TtsVoice[]>("tts_list_voices", { provider: provider || null });
}

/** 列出服务商可选模型。 */
export function listTtsModels(provider: string): Promise<string[]> {
  return invoke<string[]>("tts_list_models", { provider });
}

/** 在线合成语音（base64 音频）。 */
export function synthesizeTts(text: string, voice?: string): Promise<TtsAudio> {
  return invoke<TtsAudio>("tts_synthesize", { text, voice: voice || null });
}

/** MiMo 流式 PCM 分片。 */
export interface TtsPcmChunk {
  base64: string;
  done: boolean;
}

/**
 * MiMo 流式合成：onChunk 收 base64(PCM16LE 24kHz)；done=true 结束。
 * 非 MiMo 会抛 STREAM_UNSUPPORTED，调用方回退 synthesizeTts。
 */
export async function synthesizeTtsStream(
  text: string,
  voice: string | undefined,
  onChunk: (chunk: TtsPcmChunk) => void,
): Promise<void> {
  const { Channel } = await import("@tauri-apps/api/core");
  const ch = new Channel<TtsPcmChunk>();
  ch.onmessage = onChunk;
  await invoke<void>("tts_synthesize_stream", {
    text,
    voice: voice || null,
    onChunk: ch,
  });
}
