// 桌宠轻量聊天：只保留最近几条消息 + 发送 + SSE 事件流（与主窗口并存）

import { computed, onBeforeUnmount, ref } from "vue";
import { answerQuestion, getSettings, health, sendChat, streamEvents } from "../api";
import type { ChatMessage, StreamEvent, UserQuestion, UserQuestionAnswerItem } from "../types";
import { onTauriEvent, tauriAvailable } from "../tauri";

const MAX_MESSAGES = 8;
const HEALTH_POLL_MS = 8000;

export function usePetChat() {
  const messages = ref<ChatMessage[]>([]);
  const busy = ref(false);
  const connected = ref(false);
  const error = ref<string | null>(null);
  const composer = ref("");
  /** TTS 总开关（与主窗口共享的 diver 设置，未开启时桌宠不朗读）。 */
  const ttsEnabled = ref(false);
  const ttsVoice = ref("");
  /** 模型通过 ask_user_question 提出的问题（待用户回答）。 */
  const pendingQuestion = ref<{ requestId: string; questions: UserQuestion[] } | null>(null);
  let closeStream: (() => void) | null = null;
  let streamOpen = false;
  let healthTimer: number | null = null;
  let stopSidecarEvent: (() => void) | null = null;

  const canSend = computed(() => connected.value && !busy.value);

  function push(msg: ChatMessage) {
    messages.value.push(msg);
    if (messages.value.length > MAX_MESSAGES) {
      messages.value = messages.value.slice(-MAX_MESSAGES);
    }
  }

  function handleEvent(e: StreamEvent) {
    switch (e.type) {
      case "hello":
        connected.value = true;
        busy.value = e.busy;
        error.value = null;
        break;
      case "message":
        if (e.kind === "user") {
          push({ id: e.messageId, kind: "user", content: e.content, origin: "user", time: e.time });
        } else if (e.turnMessageId) {
          const idx = messages.value.findIndex((m) => m.id === e.turnMessageId);
          if (idx >= 0) {
            messages.value[idx] = {
              id: e.messageId,
              kind: "assistant",
              content: e.content,
              origin: e.origin,
              time: e.time,
              streaming: false,
            };
          } else {
            push({ id: e.messageId, kind: "assistant", content: e.content, origin: e.origin, time: e.time });
          }
        } else {
          push({ id: e.messageId, kind: "assistant", content: e.content, origin: e.origin, time: e.time });
        }
        break;
      case "chunk": {
        const idx = messages.value.findIndex((m) => m.id === e.messageId);
        if (idx >= 0) {
          messages.value[idx].content += e.delta;
          messages.value[idx].streaming = true;
        } else {
          push({ id: e.messageId, kind: "assistant", content: e.delta, origin: "assistant", time: Date.now(), streaming: true });
        }
        break;
      }
      case "turn":
        if (e.state === "end") {
          for (const m of messages.value) m.streaming = false;
        }
        busy.value = e.state === "start";
        break;
      case "busy":
        busy.value = e.value;
        break;
      case "question":
        pendingQuestion.value = { requestId: e.requestId, questions: e.questions };
        break;
      case "error":
        error.value = e.message;
        break;
    }
  }

  /** 提交对 ask_user_question 的回答。 */
  async function submitQuestionAnswer(answers: UserQuestionAnswerItem[]) {
    const q = pendingQuestion.value;
    if (!q) return;
    try {
      await answerQuestion(q.requestId, answers);
      pendingQuestion.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function connect() {
    try {
      const res = await fetch("/api/history");
      if (res.ok) {
        const data = (await res.json()) as { messages: ChatMessage[] };
        messages.value = data.messages.slice(-MAX_MESSAGES).map((m) => ({ ...m, streaming: false }));
      }
    } catch {
      /* 历史拉取失败不阻断 */
    }
    openStream();
    void refreshHealth();
    void refreshSettings();
  }

  function openStream() {
    closeStream?.();
    streamOpen = true;
    closeStream = streamEvents(
      handleEvent,
      (err) => {
        error.value = err instanceof Error ? err.message : String(err);
        // SSE 断开（网络层错误）：标记流已关闭，等待 health 轮询恢复后重开。
        // 注意：JSON 解析错误也会走这里，但仅当是 EventSource 的网络错误时关闭流。
        if (err instanceof Event) {
          streamOpen = false;
          connected.value = false;
        }
      },
    );
  }

  /** 探活：sidecar 恢复后自动重开事件流。 */
  async function refreshHealth() {
    try {
      const h = await health();
      connected.value = true;
      error.value = null;
      busy.value = h.busy;
      if (!streamOpen) {
        openStream();
      }
      void refreshSettings();
    } catch {
      connected.value = false;
    }
  }

  /** 同步 TTS 开关/语音（与主窗口共享 diver 设置）。 */
  async function refreshSettings() {
    try {
      const s = await getSettings();
      ttsEnabled.value = !!s.ttsEnabled;
      ttsVoice.value = s.ttsVoice ?? "";
    } catch {
      /* 设置读取失败不阻断 */
    }
  }

  function startAutoRefresh() {
    healthTimer = window.setInterval(() => {
      void refreshHealth();
    }, HEALTH_POLL_MS);
    // Tauri 环境：sidecar 状态变化（启动/停止/重启）时立即刷新
    if (tauriAvailable()) {
      void onTauriEvent("sidecar://status", () => {
        void refreshHealth();
      }).then((unlisten) => {
        stopSidecarEvent = unlisten;
      });
    }
  }

  async function send() {
    const content = composer.value.trim();
    if (!content || !canSend.value) return;
    composer.value = "";
    push({ id: `local-${Date.now()}`, kind: "user", content, origin: "user", time: Date.now() });
    busy.value = true;
    try {
      await sendChat(content);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      busy.value = false;
    }
  }

  onBeforeUnmount(() => {
    if (healthTimer !== null) window.clearInterval(healthTimer);
    stopSidecarEvent?.();
    closeStream?.();
  });

  return { messages, busy, connected, error, composer, canSend, connect, send, startAutoRefresh, ttsEnabled, ttsVoice, pendingQuestion, submitQuestionAnswer };
}
