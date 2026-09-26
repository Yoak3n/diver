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
): Promise<{ sessionId: string; messageId: string }> {
  return json(
    "/chat",
    {
      method: "POST",
      body: JSON.stringify({
        content,
        ...(images && images.length > 0 ? { images } : {}),
      }),
    },
    instanceId,
  );
}

/** 当前会话历史（重启后恢复界面）。 */
export function getHistory(instanceId?: string): Promise<{ messages: import("../types").ChatMessage[] }> {
  return json("/history", undefined, instanceId);
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
