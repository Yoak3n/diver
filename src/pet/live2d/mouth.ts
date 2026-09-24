// 口型同步（TTS 响度 / 正弦抖动）→ ParamMouthOpenY。

import { getSpeechLevel } from "../../tts";

type MouthModel = {
  internalModel: {
    coreModel: {
      setParameterValueById?: (id: string, v: number) => void;
    };
  };
};

export function createMouthController(model: MouthModel) {
  let mouthActive = false;
  let mouthFrame = 0;
  let mouthOpenSmooth = 0;
  let disposed = false;

  function sampleMouthTarget(): number {
    mouthFrame += 0.42;
    const level = getSpeechLevel();
    if (level > 0) return Math.min(1, Math.max(0, level * 3.2));
    const syllable = Math.abs(Math.sin(mouthFrame));
    const wobble = 0.55 + 0.45 * Math.sin(mouthFrame * 0.37 + 1.1);
    return Math.min(1, syllable * wobble * 1.2);
  }

  function writeMouth(open: number) {
    const core = model.internalModel.coreModel;
    const form = open * 0.55 - 0.15;
    try {
      if (typeof core.setParameterValueById === "function") {
        core.setParameterValueById("ParamMouthOpenY", open);
        core.setParameterValueById("ParamMouthForm", form);
        core.setParameterValueById("Param71", open * 0.85);
      }
    } catch {
      /* 忽略 */
    }
  }

  function tickMouth() {
    if (!mouthActive || disposed) return;
    const target = sampleMouthTarget();
    mouthOpenSmooth += (target - mouthOpenSmooth) * 0.5;
    writeMouth(mouthOpenSmooth);
  }

  function startMouth(): () => void {
    mouthActive = true;
    mouthOpenSmooth = 0;
    return () => {
      mouthActive = false;
      writeMouth(0);
    };
  }

  function destroy() {
    disposed = true;
    mouthActive = false;
    writeMouth(0);
  }

  return { startMouth, tickMouth, destroy, writeMouth };
}
