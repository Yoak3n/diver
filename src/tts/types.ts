// TTS 事件常量与请求类型。

export const TTS_SPEAK_REQUEST = "tts://speak-request";
export const TTS_SPEAK_ACK = "tts://speak-ack";
export const TTS_SPEAK_DONE = "tts://speak-done";
export const TTS_STOP = "tts://stop";

export interface TtsSpeakRequest {
  requestId: string;
  text: string;
  voice?: string;
  messageId?: string;
  /** true = 打断当前立即播（设置试听）；手动点读也带 true 以保证必播。 */
  force?: boolean;
  /** 手动点读：跳过自动去重语义（请求端已处理）。 */
  userGesture?: boolean;
}
