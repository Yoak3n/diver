// 桌宠情绪：情绪 → 动作/关键词映射（静态资源加载 + 内置缺省）。

import type { EmotionMap, PetEmotion } from "./emotion-types";

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

/** 当前缓存的映射（推断入口的缺省参数；未加载时为 null）。 */
export function currentEmotionMap(): EmotionMap | null {
  return cachedMap;
}

/** 内置缺省映射（与 emotion-map.json 保持一致，双保险）。 */
export function buildDefaultMap(): EmotionMap {
  return {
    version: 2,
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
      happy: {
        keywords: [
          "哈哈", "嘿嘿", "嘻嘻", "开心", "高兴", "喜欢", "太棒", "好耶", "真好",
          "好开心", "好喜欢", "棒极了", "太好了", "不错", "挺好", "真棒", "可爱",
          "好呀", "好啊", "好的", "好哒", "行啊", "可以的", "没问题", "耶", "耶耶",
          "哈", "嘻", "甜", "快乐", "haha", "hehe", "lol", "happy", "glad", "yay",
          "awesome", "love it", "great", "nice", "cool", "yep", "yeah", "ok",
        ],
      },
      excited: {
        keywords: [
          "兴奋", "激动", "哇", "天哪", "太厉害", "牛逼", "好强", "绝了", "炸了",
          "燃", "冲", "冲冲", "太强", "无敌", "好酷", "amazing", "awesome", "wow",
          "exciting", "so cool", "insane", "let's go", "lets go",
        ],
      },
      sad: {
        keywords: [
          "难过", "伤心", "好难过", "哭了", "呜呜", "想哭", "失望", "沮丧", "孤独",
          "好累", "唉", "唉唉", "心疼", "委屈", "郁闷", "低落", "sad", "cry",
          "upset", "lonely", "tired", "depressed", "sigh",
        ],
      },
      angry: {
        keywords: [
          "生气", "气死", "可恶", "混蛋", "讨厌", "烦死", "受不了", "滚", "愤怒",
          "火大", "烦", "气人", "可恨", "该死", "angry", "mad", "hate", "annoyed",
          "damn", "wtf",
        ],
      },
      surprised: {
        keywords: [
          "惊讶", "居然", "竟然", "真的吗", "真的假的", "不可能", "骗人", "吓到",
          "震惊", "不会吧", "什么", "啥", "咦", "诶", "哦？", "啊？", "surprised",
          "shocked", "really", "no way", "what", "wait what", "omg",
        ],
      },
      shy: {
        keywords: [
          "害羞", "不好意思", "脸红", "尴尬", "羞羞", "难为情", "别这样", "讨厌啦",
          "shy", "embarrassed", "blush",
        ],
      },
      love: {
        keywords: [
          "我爱你", "喜欢你", "亲亲", "抱抱", "想你", "宝贝", "亲爱的", "最喜欢你",
          "love you", "miss you", "kiss", "hug",
        ],
      },
      grateful: {
        keywords: [
          "谢谢", "感谢", "辛苦了", "多谢", "麻烦你了", "thanks", "thank you",
          "appreciate",
        ],
      },
      greeting: {
        keywords: [
          "你好", "早上好", "中午好", "晚上好", "嗨", "哈喽", "hello", "hi", "hey",
          "good morning", "good evening", "在吗", "在不在",
        ],
      },
      farewell: {
        keywords: [
          "再见", "拜拜", "晚安", "下次见", "走了", "睡了", "bye", "goodbye",
          "good night", "see you",
        ],
      },
      agree: {
        keywords: [
          "对对", "对的", "没错", "同意", "赞成", "嗯嗯", "是啊", "确实", "有道理",
          "好的", "好嘞", "收到", "了解", "明白", "right", "yes", "agree",
          "correct", "true", "indeed", "sure", "okay",
        ],
      },
    },
  };
}

/** 按情绪取可用动作组（优先从映射，回退 Idle）。 */
export function motionGroupsFor(emotion: PetEmotion, map: EmotionMap | null = currentEmotionMap()): string[] {
  const groups = map?.motions?.[emotion] ?? [];
  return groups.length > 0 ? groups : ["Idle"];
}
