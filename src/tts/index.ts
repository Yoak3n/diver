// 在线 TTS 朗读公共出口。
// 队列/合成在后端；前端 attach 播放器（pet/main）出声并驱动口型。

export {
  TTS_SPEAK_REQUEST,
  TTS_SPEAK_ACK,
  TTS_SPEAK_DONE,
  TTS_STOP,
  type TtsSpeakRequest,
} from "./types";
export { isTtsSpeaking, onTtsSpeakingChange, getSpeechLevel } from "./level";
export { claimSpeech } from "./spoken";
export { speakMessageText, stopSpeaking } from "./queue";
export { attachTtsPlayer, type TtsPlayerEvent } from "./player";
