// 聊天内容 → 情绪 → Live2D 动作/表情。

import { inferEmotionDetail, type PetEmotion } from "../emotion";
import type { PetModelProfile } from "../models";

const EMOTION_MIN_INTERVAL_MS = 1800;
const EXPR_MIN_INTERVAL_MS = 700;
const NOD_INTERVAL_MS = 12000;
const SOFT_EXPRS = ["by", "expression3", "expression4", "expression11", "yyy", "xxy", "001"];

function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

type PetReact = {
  setExpression: (name?: string | null) => void;
  playEmotion: (group: string, opts?: { priority?: "normal" | "force" }) => void;
  react: (
    emotion: string,
    opts?: { force?: boolean; zone?: "head" | "body" | "auto"; expressions?: string[] },
  ) => void;
};

export function usePetEmotion(opts: {
  getPet: () => PetReact | null;
  getProfile: () => PetModelProfile | undefined;
  isSpeaking: () => boolean;
  isMapReady: () => boolean;
}) {
  let lastEmotionAt = 0;
  let lastExprAt = 0;
  let lastNodAt = 0;

  function applyExpression(emotion: PetEmotion, soft = false) {
    const pet = opts.getPet();
    if (!pet) return;
    const now = performance.now();
    if (now - lastExprAt < EXPR_MIN_INTERVAL_MS) return;
    const profile = opts.getProfile();
    const list = profile?.expressionMap?.[emotion] ?? (soft ? SOFT_EXPRS : []);
    if (!list.length) return;
    lastExprAt = now;
    pet.setExpression(pickOne(list));
  }

  function reactToText(text: string) {
    const pet = opts.getPet();
    if (!pet || !opts.isMapReady()) return;
    const detail = inferEmotionDetail(text);
    const emotion = detail.emotion;
    const now = performance.now();

    applyExpression(emotion, detail.intensity !== "strong");

    if (opts.isSpeaking()) return;
    if (detail.intensity === "weak") return;
    if (emotion === "neutral" || detail.intensity === "none") {
      if (now - lastNodAt > NOD_INTERVAL_MS) {
        lastNodAt = now;
        pet.playEmotion("Nod", { priority: "normal" });
      }
      return;
    }
    if (now - lastEmotionAt < EMOTION_MIN_INTERVAL_MS) {
      applyExpression(emotion, false);
      return;
    }

    const profile = opts.getProfile();
    lastEmotionAt = now;
    lastExprAt = now;
    pet.react(emotion, {
      expressions: profile?.expressionMap?.[emotion],
    });
    console.log("[pet] emotion", emotion, detail.intensity);
  }

  return { reactToText, applyExpression };
}
