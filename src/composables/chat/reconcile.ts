// 会话池对账（SSE 断缝补缺）：SSE 只投递实时事件，断线/重载窗口里广播过的
// 消息不会重放；而 loadHistory 只在空池时填充，非空池的缺口会永久残留——
// 表现为「发出去的消息不见了」，且折叠把上一轮最终回复误当过程吞进下一组。
// SSE 每次建立（hello）时以 /history 为准补缺。纯函数，便于对账逻辑单测。

import type { ChatMessage } from "../../types";

/** 同一条消息（内容兜底判定）：同类 + 同正文 + 5s 时间窗。 */
function isSameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.kind === b.kind &&
    a.content === b.content &&
    Math.abs(a.time - b.time) <= 5000
  );
}

/**
 * 把历史视图并进本地池：只补本地缺失的消息（按 id；未回填的 local- 回声按
 * 内容+时间窗去重），按时间序原位插入。空正文且无图的消息（纯工具步骤气泡）
 * 只按 id 判重——它们密集相邻且正文不可区分，内容兜底会误伤。
 * 返回新数组与补充条数（0 = 无缺口，调用方不必重排）。
 */
export function mergeHistoryIntoPool(
  pool: readonly ChatMessage[],
  history: readonly ChatMessage[],
): { merged: ChatMessage[]; added: number } {
  const known = new Set(pool.map((m) => m.id));
  const out = [...pool];
  let added = 0;
  for (const h of history) {
    if (known.has(h.id)) continue;
    const hasBody = h.content.trim() !== "" || (h.images?.length ?? 0) > 0;
    if (hasBody && out.some((m) => m.id.startsWith("local-") && isSameMessage(m, h))) {
      continue;
    }
    const msg: ChatMessage = { ...h, streaming: false };
    const at = out.findIndex((m) => m.time > h.time);
    if (at < 0) out.push(msg);
    else out.splice(at, 0, msg);
    added += 1;
  }
  return { merged: out, added };
}

/** 拆掉全部折叠组（摘要行 + 成员标记）：对账补缺后重建折叠用。 */
export function stripActivityFolds(list: readonly ChatMessage[]): ChatMessage[] {
  return list
    .filter((m) => m.kind !== "activity-summary")
    .map(({ activityGroupId: _dropped, ...rest }) => rest as ChatMessage);
}
