// 在线 TTS 朗读公共出口（行为与历史 `src/tts.ts` 一致）。
// 拆分：types（事件/请求）· level（响度）· pcm（流式）· spoken（去重）· queue（队列与入口）。

export {
  TTS_SPEAK_REQUEST,
  TTS_SPEAK_ACK,
  TTS_SPEAK_DONE,
  TTS_STOP,
  type TtsSpeakRequest,
} from "./types";
export { isTtsSpeaking, onTtsSpeakingChange, getSpeechLevel } from "./level";
export { claimSpeech } from "./spoken";
export { speakLocal, speakMessageText, stopSpeaking } from "./queue";
