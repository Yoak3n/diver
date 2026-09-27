// 对话域端点：健康 / 设置快照 / 发送 / 历史 / 提问回答。
// 会话面函数带可选 instanceId（P2-3 私聊按实例寻址）；设置读写走 active。

import type { ChatImage, HealthInfo, SettingsInfo } from "../types";
import { json } from "./base";

export function health(instanceId?: string): Promise<HealthInfo> {
  return json<HealthInfo>("/health", undefined, instanceId);
}

export function getSettings(instanceId?: string): Promise<SettingsInfo> {
  return json<SettingsInfo>("/settings", undefined, instanceId);
}

export function saveSettings(body: {
  providerConfigs?: Record<string, Record<string, string>>;
  provider?: string;
  model?: string;
  petInteraction?: import("../types").PetInteractionSettings;
}): Promise<{
  modelConfigured: boolean;
  provider: string;
  model: string;
  petInteraction?: import("../types").PetInteractionSettings;
}> {
  return json("/settings", { method: "POST", body: JSON.stringify(body) });
}

export function sendChat(
  content: string,
  images?: ChatImage[],
  instanceId?: string,
  opts?: {
    queue?: boolean;
    group?: { id: string; name: string };
    /** 客户端消息 id：群广播 fan-out 共享同一个 id，合并流按 id 去重 */
    clientMsgId?: string;
  },
): Promise<{ sessionId: string; messageId: string; queued?: boolean | string }> {
  // P2-3/P2-4：queue=忙时排队不插话（群聊广播用）；group={id,name} 群聊归属
  // （后端注入在场提示首行 + groupId 归属）。
  return json(
    "/chat",
    {
      method: "POST",
      body: JSON.stringify({
        content,
        ...(images && images.length > 0 ? { images } : {}),
        ...(opts?.queue === true ? { queue: true } : {}),
        ...(opts?.group ? { group: opts.group } : {}),
        ...(opts?.clientMsgId ? { clientMsgId: opts.clientMsgId } : {}),
      }),
    },
    instanceId,
  );
}

/** 历史分页结果：hasMore 表示还有更早的消息未加载。 */
export interface HistoryPage {
  messages: import("../types").ChatMessage[];
  hasMore?: boolean;
}

/**
 * 当前会话历史（分页）：
 * - 缺省：末尾 200 条（旧约定）
 * - { rounds }：最近 N 轮尾窗（打开时只加载一两周对话）
 * - { before/beforeTime, limit }：锚点之前一块（滚动到顶懒加载更早消息）
 */
export function getHistory(
  instanceId?: string,
  opts?: { rounds?: number; before?: string; beforeTime?: number; limit?: number },
): Promise<HistoryPage> {
  const params = new URLSearchParams();
  if (opts?.rounds !== undefined) params.set("rounds", String(opts.rounds));
  if (opts?.before !== undefined) params.set("before", opts.before);
  if (opts?.beforeTime !== undefined) params.set("beforeTime", String(opts.beforeTime));
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return json<HistoryPage>(`/history${qs ? `?${qs}` : ""}`, undefined, instanceId);
}

/** 回答 ask_user_question 提出的问题。 */
export function answerQuestion(
  requestId: string,
  answers: { id: string; selected: string[]; custom?: string }[],
  instanceId?: string,
): Promise<{ ok: boolean }> {
  return json(
    "/questions/answer",
    {
      method: "POST",
      body: JSON.stringify({ requestId, answers }),
    },
    instanceId,
  );
}
