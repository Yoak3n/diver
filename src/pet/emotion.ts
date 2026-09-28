// Diver 桌宠：聊天气泡文本 → 情绪 推断（纯前端启发式）
//
// 借鉴 N.E.K.O 的 _infer_emotion_from_text（config/prompts/prompts_emotion.py）：
// 按语种关键词表打分，处理否定词（"不/没/别" + 程度副词）与转折（"但/但是/不过"），
// 返回最高分情绪；无关键词命中时用语气/标点弱线索兜底。
// 不做 LLM 调用 —— 桌宠侧保持零延迟零成本。
//
// 分层：emotion-types.ts 类型 | emotion-lexicon.ts 启发式词表与转折切分
// | emotion-map.ts 情绪映射（加载/缺省） | emotion-infer.ts 推断纯逻辑；
// 本文件只做公共 re-export。

export * from "./emotion-lexicon";
export * from "./emotion-map";
export * from "./emotion-infer";
export * from "./emotion-types";
