// 聊天传输层（chat/ 子模块）：HTTP/SSE 连接、健康检查、发送、回答提问。
// 不持有消息/工具等 UI 状态；状态由 chat/state 提供。

import { answerQuestion, getSettings, health, sendChat, streamEvents } from "../../api";
import type { UserQuestionAnswerItem } from "../../types";
import type { createChatState } from "./state";

export type ChatState = ReturnType<typeof createChatState>;

export function createChatTransport(state: ChatState) {
  let closeStream: (() => void) | null = null;

  async function refreshHealth() {
    try {
      const h = await health();
      state.healthInfo.value = h;
      state.busy.value = h.busy;
      state.error.value = null;
    } catch (err) {
      state.error.value = err instanceof Error ? err.message : String(err);
      state.healthInfo.value = null;
    }
  }

  async function connect() {
    state.connecting.value = true;
    await refreshHealth();
    try {
      state.settingsInfo.value = await getSettings();
    } catch {
      /* 设置接口失败不阻断 */
    }
    try {
      const res = await fetch("/api/history");
      if (res.ok) {
        const data = (await res.json()) as { messages: import("../../types").ChatMessage[] };
        state.messages.value = data.messages.map((m) => ({ ...m, streaming: false }));
      }
    } catch {
      /* 历史拉取失败不阻断 */
    }
    state.connecting.value = false;
    openStream();
    state.scrollToBottom();
  }

  function openStream() {
    closeStream?.();
    closeStream = streamEvents(
      state.handleStreamEvent,
      (err) => {
        state.error.value = err instanceof Error ? err.message : String(err);
      },
    );
  }

  async function reconnect() {
    await refreshHealth();
    openStream();
  }

  async function send() {
    const content = state.composer.value.trim();
    if (!content) return;
    if (!state.canSend.value) return;
    state.composer.value = "";
    const localId = `local-${Date.now()}`;
    state.upsertMessage({ id: localId, kind: "user", content, origin: "user", time: Date.now() });
    state.busy.value = true;
    try {
      await sendChat(content);
    } catch (err) {
      state.error.value = err instanceof Error ? err.message : String(err);
      const idx = state.messages.value.findIndex((m) => m.id === localId);
      if (idx >= 0) state.messages.value.splice(idx, 1);
      state.busy.value = false;
    }
  }

  async function submitQuestionAnswer(answers: UserQuestionAnswerItem[]) {
    const q = state.pendingQuestion.value;
    if (!q) return;
    try {
      await answerQuestion(q.requestId, answers);
      state.pendingQuestion.value = null;
    } catch (err) {
      state.error.value = err instanceof Error ? err.message : String(err);
      // 保持卡片可见，用户可重试
    }
  }

  function dispose() {
    closeStream?.();
  }

  return {
    refreshHealth,
    connect,
    openStream,
    reconnect,
    send,
    submitQuestionAnswer,
    dispose,
  };
}
