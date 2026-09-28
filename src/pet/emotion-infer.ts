// 桌宠情绪：文本 → 情绪推断（纯逻辑启发式，无 IO）。

import type { EmotionDetail, EmotionMap, PetEmotion } from "./emotion-types";
import {
  DEGREE_ADVERBS,
  EMOTION_PRIORITY,
  LOCKED_EMOTIONS,
  NEGATION_PREFIXES,
  lastConjunctionCut,
} from "./emotion-lexicon";
import { buildDefaultMap, currentEmotionMap } from "./emotion-map";

/**
 * 推断文本情绪。
 * @param text 聊天气泡文本
 * @returns 最高分情绪（无命中返回 neutral）
 */
export function inferEmotion(text: string, map: EmotionMap | null = currentEmotionMap()): PetEmotion {
  return inferEmotionDetail(text, map).emotion;
}

/**
 * 推断文本情绪 + 强度。
 * 关键词命中 → strong；仅有语气/标点线索 → weak；都没有 → none/neutral。
 * weak 仍可驱动「表情」但跳过大动作，让闲聊也有响应感。
 */
export function inferEmotionDetail(
  text: string,
  map: EmotionMap | null = currentEmotionMap(),
): EmotionDetail {
  const src = (text ?? "").trim();
  if (!src) return { emotion: "neutral", intensity: "none" };

  // 按转折连词切分：取最后一段（转折后的情绪权重更高）
  let segment = src;
  const cut = lastConjunctionCut(src);
  if (cut > 0) segment = src.slice(cut).trim() || src;

  const lower = segment.toLowerCase();
  const isCjk = (s: string) => /^[一-鿿]+$/.test(s);

  // 强情绪锁定：love/grateful 是明确表达（非情绪状态），命中即优先返回
  for (const [emotion, kws] of Object.entries(LOCKED_EMOTIONS)) {
    for (const kw of kws) {
      const kwLower = kw.toLowerCase();
      const hit = isCjk(kwLower)
        ? lower.includes(kwLower)
        : new RegExp(`(^|[^a-z0-9])${escapeRegex(kwLower)}([^a-z0-9]|$)`).test(lower);
      if (hit) {
        // 检查否定："不爱你" 不应触发 love
        const kwIdx = lower.indexOf(kwLower);
        if (kwIdx > 0) {
          const before = lower.slice(0, kwIdx);
          if (NEGATION_PREFIXES.some((neg) => before.endsWith(neg))) continue;
        }
        return { emotion: emotion as PetEmotion, intensity: "strong" };
      }
    }
  }

  const scores = new Map<string, number>();

  for (const [emotion, entry] of Object.entries(map?.emotions ?? buildDefaultMap().emotions)) {
    let score = 0;
    for (const kw of entry.keywords) {
      const kwLower = kw.toLowerCase();
      // 简单包含匹配（中文词无空格，英文词整词匹配）
      let hit = false;
      if (isCjk(kwLower)) {
        hit = lower.includes(kwLower);
      } else {
        hit = new RegExp(`(^|[^a-z0-9])${escapeRegex(kwLower)}([^a-z0-9]|$)`).test(lower);
      }
      if (!hit) continue;

      // 检查关键词前是否有否定前缀（在原文中查找关键词位置前的最近否定词）
      const kwIdx = lower.indexOf(kwLower);
      if (kwIdx > 0) {
        const before = lower.slice(0, kwIdx);
        if (NEGATION_PREFIXES.some((neg) => before.endsWith(neg))) {
          continue; // "不开心" 不算 happy
        }
      }
      score += 1;
    }

    // 程度副词加权
    for (const [re, w] of DEGREE_ADVERBS) {
      const m = lower.match(re);
      if (m) score *= w ** m.length;
    }

    if (score > 0) scores.set(emotion, score);
  }

  if (scores.size > 0) {
    // 取最高分；同分按 EMOTION_PRIORITY 排序
    let best: PetEmotion = "neutral";
    let bestScore = 0;
    for (const [emotion, score] of scores) {
      if (
        score > bestScore ||
        (score === bestScore &&
          EMOTION_PRIORITY.indexOf(emotion as PetEmotion) < EMOTION_PRIORITY.indexOf(best))
      ) {
        best = emotion as PetEmotion;
        bestScore = score;
      }
    }
    return { emotion: best, intensity: "strong" };
  }

  // 关键词未命中：语气/标点弱线索（让闲聊也有表情响应）
  const weak = inferWeakTone(src, lower);
  if (weak) return { emotion: weak, intensity: "weak" };
  return { emotion: "neutral", intensity: "none" };
}

/** 语气/标点弱线索（无关键词时的兜底，只够驱动表情，不够大动作）。 */
function inferWeakTone(src: string, lower: string): PetEmotion | null {
  // 感叹 / 波浪 / 重复语气词 → 偏开心或兴奋
  const bangCount = (src.match(/[!！]/g) ?? []).length;
  const tilde = /[~～]/.test(src);
  const laughish = /(哈|嘿|嘻|呵){2,}|w{3,}|233|666|hh/.test(lower);
  if (bangCount >= 2 || (bangCount >= 1 && tilde)) return "excited";
  if (bangCount >= 1 || tilde || laughish) return "happy";

  // 疑问 / 惊叹语气 → 偏惊讶
  const qCount = (src.match(/[?？]/g) ?? []).length;
  if (qCount >= 1 && /(真的|什么|啥|怎么|为什么|居然|竟然|不会吧)/.test(lower)) {
    return "surprised";
  }

  // 负向语气词 / 叹气
  if (/(唔|呜|唉|……|\.\.\.)/.test(src) && bangCount === 0) return "sad";

  // 短促肯定（嗯/哦/好）→ 点头级 agree
  if (/^(嗯+|哦+|好+|行+|ok+|嗯好)[.。!！~～]?$/.test(lower)) return "agree";

  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
