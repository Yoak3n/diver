// 语音朗读请求执行 + 口型同步。

import {
  onTauriEvent,
  emitTauriEvent,
} from "../../tauri";
import {
  speakLocal,
  onTtsSpeakingChange,
  stopSpeaking,
  TTS_STOP,
  TTS_SPEAK_REQUEST,
  TTS_SPEAK_ACK,
  TTS_SPEAK_DONE,
  type TtsSpeakRequest,
} from "../../tts";

export function useLipSync(opts: {
  getTtsVoice: () => string;
  startMouth: () => (() => void) | null;
}) {
  let stopMouth: (() => void) | null = null;
  let offTtsMouth: (() => void) | null = null;
  let speaking = false;

  function isSpeaking() {
    return speaking;
  }

  function handleTtsRequest(req: TtsSpeakRequest) {
    if (!req?.text) return;
    void emitTauriEvent(TTS_SPEAK_ACK, { requestId: req.requestId });
    void (async () => {
      try {
        await speakLocal(req.text, opts.getTtsVoice() || undefined, { force: !!req.force });
      } catch {
        /* ignore */
      } finally {
        try {
          await emitTauriEvent(TTS_SPEAK_DONE, { requestId: req.requestId });
        } catch {
          /* ignore */
        }
      }
    })();
  }

  function bindTts() {
    void onTauriEvent<TtsSpeakRequest>(TTS_SPEAK_REQUEST, (req) => {
      handleTtsRequest(req);
    });
    offTtsMouth = onTtsSpeakingChange((v) => {
      speaking = v;
      if (v) {
        stopMouth?.();
        stopMouth = opts.startMouth();
      } else {
        stopMouth?.();
        stopMouth = null;
      }
    });
    void onTauriEvent(TTS_STOP, () => {
      stopSpeaking({ broadcast: false });
    });
  }

  function dispose() {
    offTtsMouth?.();
    offTtsMouth = null;
    stopMouth?.();
    stopMouth = null;
  }

  return { isSpeaking, bindTts, dispose };
}
