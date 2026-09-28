// 桌宠情绪：启发式词表与转折切分（纯逻辑常量）。

import type { PetEmotion } from "./emotion-types";

/** 否定前缀：直接否定其后的情绪词（"不/没/别/不太/一点都不"）。 */
export const NEGATION_PREFIXES = [
  "一点也不", "一点都不", "不太", "不是", "没有", "不", "没", "别", "毋", "勿",
  "not", "no", "never", "don't", "dont", "isn't", "isnt", "aren't", "arent", "wasn't", "wasnt", "weren't", "werent",
  "não", "no", "non", "ne", "nicht", "non",
];

/** 程度副词：命中后把该情绪词分数加权（>1 增强，<1 削弱）。 */
export const DEGREE_ADVERBS: [RegExp, number][] = [
  [/非常|特别|超|太|好|真|很|极|无比|十分|相当|格外|尤其|超级|巨|贼/g, 1.5],
  [/有点|稍微|略|些许|有些|还算|勉强|一点|一点儿/g, 0.6],
  [/very|really|so|super|extremely|incredibly|totally|absolutely|too|quite/g, 1.5],
  [/a little|a bit|slightly|somewhat|kinda|sort of/g, 0.6],
];

/** 转折连词：转折后的情绪覆盖转折前的（"难过，但很开心" → happy）。
 *  单字词中仅 `可` 要求后跟标点——"可能/可怕/可以/可惜" 里的 `可` 不是转折；
 *  `但`/`却` 作为转折连词语义可靠，无需标点（"难过但开心" 也应切分）。 */
export const CONJUNCTIONS = ["但是", "不过", "然而", "可是", "虽然", "只是", "但", "却"];
/** 需要后跟标点才有效的单字连词（避免误伤常见词）。 */
export const CONJ_REQUIRE_PUNCT = new Set(["可"]);
export const CONJ_PUNCT = /[，,。.!！?？；;：:\s]/;

/** 找到最后一个有效的转折切分点（返回切分后文本的起始下标，无则 -1）。 */
export function lastConjunctionCut(src: string): number {
  let best = -1;
  for (const conj of CONJUNCTIONS) {
    const idx = src.lastIndexOf(conj);
    if (idx <= 0) continue;
    const afterStart = idx + conj.length;
    if (afterStart >= src.length) continue; // 转折词在末尾，无后续内容
    if (CONJ_REQUIRE_PUNCT.has(conj) && !CONJ_PUNCT.test(src[afterStart])) continue; // "可" 须后跟标点
    if (!src.slice(afterStart).trim()) continue;
    if (afterStart > best) best = afterStart;
  }
  return best;
}

/** 强情绪关键词：一旦命中即锁定（明确表达，非情绪状态描述）。 */
export const LOCKED_EMOTIONS: Record<string, string[]> = {
  love: ["我爱你", "爱你", "亲亲", "抱抱", "想你", "宝贝", "亲爱的", "love you", "miss you", "kiss", "hug"],
  grateful: ["谢谢你", "谢谢", "感谢", "辛苦了", "多谢", "thanks", "thank you", "appreciate"],
};

/** 情绪优先级：同分时按此顺序取（前面优先）。 */
export const EMOTION_PRIORITY: PetEmotion[] = [
  "love", "excited", "angry", "surprised", "sad", "shy", "grateful", "happy",
  "greeting", "farewell", "agree",
];
