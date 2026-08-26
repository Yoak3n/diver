// Diver 桌宠：聊天气泡文本 → 情绪 推断（纯前端启发式）
//
// 借鉴 N.E.K.O 的 _infer_emotion_from_text（config/prompts/prompts_emotion.py）：
// 按语种关键词表打分，处理否定词（"不/没/别" + 程度副词）与转折（"但/但是/不过"），
// 返回最高分情绪；无命中返回 neutral。不做 LLM 调用 —— 桌宠侧保持零延迟零成本。

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

/** 否定前缀：直接否定其后的情绪词（"不/没/别/不太/一点都不"）。 */
const NEGATION_PREFIXES = [
  "一点也不", "一点都不", "不太", "不是", "没有", "不", "没", "别", "毋", "勿",
  "not", "no", "never", "don't", "dont", "isn't", "isnt", "aren't", "arent", "wasn't", "wasnt", "weren't", "werent",
  "não", "no", "non", "ne", "nicht", "non",
];

/** 程度副词：命中后把该情绪词分数加权（>1 增强，<1 削弱）。 */
const DEGREE_ADVERBS: [RegExp, number][] = [
  [/非常|特别|超|太|好|真|很|极|无比|十分|相当|格外|尤其|超级|巨|贼/g, 1.5],
  [/有点|稍微|略|些许|有些|还算|勉强|一点|一点儿/g, 0.6],
  [/very|really|so|super|extremely|incredibly|totally|absolutely|too|quite/g, 1.5],
  [/a little|a bit|slightly|somewhat|kinda|sort of/g, 0.6],
];

/** 转折连词：转折后的情绪覆盖转折前的（"难过，但很开心" → happy）。
 *  单字词中仅 `可` 要求后跟标点——"可能/可怕/可以/可惜" 里的 `可` 不是转折；
 *  `但`/`却` 作为转折连词语义可靠，无需标点（"难过但开心" 也应切分）。 */
const CONJUNCTIONS = ["但是", "不过", "然而", "可是", "虽然", "只是", "但", "却"];
/** 需要后跟标点才有效的单字连词（避免误伤常见词）。 */
const CONJ_REQUIRE_PUNCT = new Set(["可"]);
const CONJ_PUNCT = /[，,。.!！?？；;：:\s]/;

/** 找到最后一个有效的转折切分点（返回切分后文本的起始下标，无则 -1）。 */
function lastConjunctionCut(src: string): number {
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
const LOCKED_EMOTIONS: Record<string, string[]> = {
  love: ["我爱你", "爱你", "亲亲", "抱抱", "想你", "宝贝", "亲爱的", "love you", "miss you", "kiss", "hug"],
  grateful: ["谢谢你", "谢谢", "感谢", "辛苦了", "多谢", "thanks", "thank you", "appreciate"],
};

/** 情绪优先级：同分时按此顺序取（前面优先）。 */
const EMOTION_PRIORITY: PetEmotion[] = [
  "love", "excited", "angry", "surprised", "sad", "shy", "grateful", "happy",
  "greeting", "farewell", "agree",
];

let cachedMap: EmotionMap | null = null;

/** 加载情绪映射（带缓存，静态资源失败时用内置缺省）。 */
export async function loadEmotionMap(): Promise<EmotionMap> {
  if (cachedMap) return cachedMap;
  try {
    const res = await fetch("/pet/emotion-map.json");
    if (res.ok) {
      cachedMap = (await res.json()) as EmotionMap;
      return cachedMap;
    }
  } catch {
    /* 静态资源不可用时回退内置 */
  }
  cachedMap = buildDefaultMap();
  return cachedMap;
}

/** 内置缺省映射（与 emotion-map.json 保持一致，双保险）。 */
function buildDefaultMap(): EmotionMap {
  return {
    version: 1,
    motions: {
      happy: ["Happy", "Nod", "Wave"],
      excited: ["Happy", "Wave"],
      sad: ["Sad", "Nod"],
      angry: ["Angry"],
      surprised: ["Surprised", "Shy"],
      shy: ["Shy", "Happy"],
      love: ["Shy", "Happy"],
      grateful: ["Nod", "Happy"],
      greeting: ["Wave", "Happy"],
      farewell: ["Wave", "Sad"],
      agree: ["Nod"],
      neutral: ["Nod", "Idle"],
    },
    emotions: {
      happy: { keywords: ["哈哈", "嘿嘿", "嘻嘻", "开心", "高兴", "喜欢", "太棒", "好耶", "真好", "好开心", "爱你", "好喜欢", "棒极了", "太好了", "haha", "hehe", "lol", "happy", "glad", "yay", "awesome", "love it", "great"] },
      excited: { keywords: ["兴奋", "激动", "哇", "天哪", "太厉害", "牛逼", "好强", "awesome", "amazing", "wow", "exciting", "so cool"] },
      sad: { keywords: ["难过", "伤心", "好难过", "哭了", "呜呜", "想哭", "失望", "沮丧", "孤独", "好累", "唉", "sad", "cry", "upset", "lonely", "tired", "depressed"] },
      angry: { keywords: ["生气", "气死", "可恶", "混蛋", "讨厌", "烦死", "受不了", "滚", "愤怒", "火大", "angry", "mad", "hate", "annoyed", "damn", "wtf", "烦"] },
      surprised: { keywords: ["惊讶", "居然", "竟然", "真的吗", "不可能", "骗人", "吓到", "震惊", "surprised", "shocked", "really", "no way", "what", "wait what"] },
      shy: { keywords: ["害羞", "不好意思", "脸红", "尴尬", "羞羞", "难为情", "shy", "embarrassed", "blush"] },
      love: { keywords: ["我爱你", "喜欢你", "亲亲", "抱抱", "想你", "宝贝", "亲爱的", "love you", "miss you", "kiss", "hug"] },
      grateful: { keywords: ["谢谢", "感谢", "辛苦了", "多谢", "thanks", "thank you", "appreciate"] },
      greeting: { keywords: ["你好", "早上好", "中午好", "晚上好", "嗨", "哈喽", "hello", "hi", "hey", "good morning", "good evening"] },
      farewell: { keywords: ["再见", "拜拜", "晚安", "下次见", "bye", "goodbye", "good night", "see you"] },
      agree: { keywords: ["对", "没错", "同意", "赞成", "嗯嗯", "是啊", "确实", "有道理", "right", "yes", "agree", "correct", "true", "indeed"] },
    },
  };
}

/** 按情绪取可用动作组（优先从映射，回退 Idle）。 */
export function motionGroupsFor(emotion: PetEmotion, map: EmotionMap | null = cachedMap): string[] {
  const groups = map?.motions?.[emotion] ?? [];
  return groups.length > 0 ? groups : ["Idle"];
}

/**
 * 推断文本情绪。
 * @param text 聊天气泡文本
 * @returns 最高分情绪（无命中返回 neutral）
 */
export function inferEmotion(text: string, map: EmotionMap | null = cachedMap): PetEmotion {
  const src = (text ?? "").trim();
  if (!src) return "neutral";

  // 按转折连词切分：取最后一段（转折后的情绪权重更高）
  let segment = src;
  const cut = lastConjunctionCut(src);
  if (cut > 0) segment = src.slice(cut).trim() || src;

  const lower = segment.toLowerCase();

  // 强情绪锁定：love/grateful 是明确表达（非情绪状态），命中即优先返回
  for (const [emotion, kws] of Object.entries(LOCKED_EMOTIONS)) {
    for (const kw of kws) {
      const kwLower = kw.toLowerCase();
      const hit = /^[\u4e00-\u9fff]+$/.test(kwLower)
        ? lower.includes(kwLower)
        : new RegExp(`(^|[^a-z0-9])${escapeRegex(kwLower)}([^a-z0-9]|$)`).test(lower);
      if (hit) {
        // 检查否定："不爱你" 不应触发 love
        const kwIdx = lower.indexOf(kwLower);
        if (kwIdx > 0) {
          const before = lower.slice(0, kwIdx);
          if (NEGATION_PREFIXES.some((neg) => before.endsWith(neg))) continue;
        }
        return emotion as PetEmotion;
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
      if (/^[\u4e00-\u9fff]+$/.test(kwLower)) {
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

  if (scores.size === 0) return "neutral";

  // 取最高分；同分按 EMOTION_PRIORITY 排序
  let best: PetEmotion = "neutral";
  let bestScore = 0;
  for (const [emotion, score] of scores) {
    if (score > bestScore || (score === bestScore && EMOTION_PRIORITY.indexOf(emotion as PetEmotion) < EMOTION_PRIORITY.indexOf(best))) {
      best = emotion as PetEmotion;
      bestScore = score;
    }
  }
  return best;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
