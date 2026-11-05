// 好奇心清单的展示映射（纯函数，可单测）。

/** 来源 → 人读标签：chat:group:123 → 群 123。 */
export function sourceLabel(source: string): string {
  if (source.startsWith("chat:group:")) return `群 ${source.slice("chat:group:".length)}`;
  if (source.startsWith("chat:private:")) return `私聊 ${source.slice("chat:private:".length)}`;
  if (source.startsWith("note:")) return "笔记";
  if (source.startsWith("subscription:")) return "订阅";
  if (source.startsWith("platform:")) return "B站";
  if (source === "entity") return "实体";
  if (source === "topic") return "话题";
  if (source === "manual") return "手动";
  return source;
}

/** 原因 → 短标签（列表里只展示一个词）。 */
export function reasonLabel(reason: string): string {
  switch (reason) {
    case "chat_mention":
      return "群聊";
    case "note_pending":
      return "待查";
    case "note":
      return "笔记";
    case "entity":
      return "实体";
    case "release":
      return "release";
    case "watch":
      return "更新";
    case "platform_trend":
      return "B站";
    case "topic_uncertain":
    case "topic_frequent":
    case "topic":
      return "话题";
    case "manual":
    case "fallback":
      return "手动";
    default:
      return reason;
  }
}

/** 距今多久：<1h 用分钟，<2d 用小时，其余用天。 */
export function fmtAgo(ts: number, now = Date.now()): string {
  if (!ts) return "从未";
  const delta = Math.max(0, now - ts);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 2 * 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}
