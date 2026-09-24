// 语音朗读：挂载桌宠播放端 + 口型同步。
// 合成/队列在后端；这里只 attach 播放器并按 speaking 态驱动嘴型。

import { isTtsSpeaking, onTtsSpeakingChange } from "../../tts";
import { attachTtsPlayer } from "../../tts/player";

export function useLipSync(opts: {
  startMouth: () => (() => void) | null;
}) {
  let stopMouth: (() => void) | null = null;
  let offTtsMouth: (() => void) | null = null;
  let detachPlayer: (() => void) | null = null;
  let bound = false;

  function isSpeaking() {
    return isTtsSpeaking();
  }

  function bindTts() {
    if (bound) return;
    bound = true;
    void attachTtsPlayer("pet").then((detach) => {
      if (bound) detachPlayer = detach;
      else detach();
    });
    offTtsMouth = onTtsSpeakingChange((v) => {
      if (v) {
        stopMouth?.();
        stopMouth = opts.startMouth();
      } else {
        stopMouth?.();
        stopMouth = null;
      }
    });
  }

  function dispose() {
    bound = false;
    offTtsMouth?.();
    offTtsMouth = null;
    stopMouth?.();
    stopMouth = null;
    detachPlayer?.();
    detachPlayer = null;
  }

  return { isSpeaking, bindTts, dispose };
}
