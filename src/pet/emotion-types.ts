// 桌宠情绪：类型定义。

export type PetEmotion =
  | "happy" | "excited" | "sad" | "angry" | "surprised"
  | "shy" | "love" | "grateful" | "greeting" | "farewell" | "agree"
  | "neutral";

export interface EmotionMapEntry {
  keywords: string[];
  /** 动作组（从 emotion-map.json 读取） */
  motions?: string[];
}

export interface EmotionMap {
  version: number;
  description?: string;
  motions: Record<string, string[]>;
  emotions: Record<string, EmotionMapEntry>;
}

export interface EmotionDetail {
  emotion: PetEmotion;
  /** strong=明确情绪词；weak=仅语气/标点线索；none=未识别 */
  intensity: "strong" | "weak" | "none";
}
