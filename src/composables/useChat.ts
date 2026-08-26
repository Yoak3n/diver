// 聊天核心状态与逻辑（旧单文件版）
//
// 已迁移至 useChat-v2.ts + chatState.ts + chatTransport.ts；
// 本文件保留仅为降低删除风险，当前 App.vue 已改为使用 useChat-v2。

import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { answerQuestion, getSettings, health, sendChat, streamEvents } from "../api";
import type { ChatMessage, HealthInfo, SettingsInfo, StreamEvent, ToolActivity, UserQuestion, UserQuestionAnswerItem } from "../types";
import { speakMessageText } from "../tts";

export function useChat() {
  // ---------- 状态 ----------
  const healthInfo = ref<HealthInfo | null>(null);
  const settingsInfo = ref<SettingsInfo | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const tools = ref<ToolActivity[]>([]);
  const busy = ref(false);
  const connecting = ref(true);
  const error = ref<string | null>(null);
  const composer = ref("");
  /** 模型通过 ask_user_question 提出的问题（待用户回答）。 */
  const pendingQuestion = ref<{ requestId: string; questions: UserQuestion[] } | null>(null);
  let closeStream: (() => void) | null = null;
  let ttsSource: (() => { enabled: boolean; voice: string } | null) | null = null;

  // ---------- 派生 ----------
  const personaName = computed(() => healthInfo.value?.persona || "");
  const modelConfigured = computed(() => !!healthInfo.value?.modelConfigured);
  const providerNameOf = (p: string): string =>
    p === "opencode-go" ? "opencode-go" : p === "deepseek-official" ? "DeepSeek" : p;
  const currentModelLabel = computed(() => {
    const h = healthInfo.value;
    if (!h) return "";
    return `${providerNameOf(h.provider)} · ${h.model}`;
  });
  const statusText = computed(() => {
    if (connecting.value) return "连接中…";
    if (!healthInfo.value) return "离线";
    if (busy.value) return "思考中…";
    if (!modelConfigured.value) return "未配置模型";
    return "在线";
  });
  const canSend = computed(() =>
    !!healthInfo.value?.ok && modelConfigured.value && !connecting.value,
  );

  // ---------- TTS 源注入（由 useSettings 提供开关与语音） ----------
  function setTtsSource(fn: () => { enabled: boolean; voice: string } | null): void {
    ttsSource = fn;
  }

  async function maybeSpeak(msg?: ChatMessage) {
    if (!msg || msg.kind !== "assistant" || msg.streaming) return;
    const tts = ttsSource?.();
    if (!tts?.enabled || !msg.content.trim()) return;
    try {
      await speakMessageText(msg.content, tts.voice);
    } catch {
      /* TTS 不可用时不打扰 */
    }
  }

  async function speakMessage(msg: ChatMessage) {
    const tts = ttsSource?.();
    await speakMessageText(msg.content, tts?.voice ?? "");
  }

  // ---------- 消息操作 ----------
  function upsertMessage(msg: Omit<ChatMessage, "streaming"> & { streaming?: boolean }) {
    const idx = messages.value.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      messages.value[idx] = { ...messages.value[idx], ...msg };
    } else {
      messages.value.push({ streaming: false, ...msg });
    }
    scrollToBottom();
  }

  function appendChunk(messageId: string, delta: string) {
    const idx = messages.value.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      messages.value[idx].content += delta;
      messages.value[idx].streaming = true;
    } else {
      messages.value.push({
        id: messageId,
        kind: "assistant",
        content: delta,
        origin: "assistant",
        time: Date.now(),
        streaming: true,
      });
    }
    scrollToBottom();
  }

  // ---------- 事件流 ----------
  function handleStreamEvent(e: StreamEvent) {
    switch (e.type) {
      case "hello":
        healthInfo.value = {
          ok: true,
          persona: e.persona,
          provider: e.provider ?? "deepseek-official",
          model: e.model,
          modelConfigured: e.modelConfigured,
          sessionId: e.sessionId,
          busy: e.busy,
        };
        busy.value = e.busy;
        break;
      case "message":
        if (e.kind === "user") {
          const dup = messages.value.some(
            (m) => m.kind === "user" && m.content === e.content && m.id.startsWith("local-"),
          );
          if (!dup) upsertMessage({ id: e.messageId, kind: "user", content: e.content, origin: "user", time: e.time });
        } else if (e.turnMessageId) {
          const idx = messages.value.findIndex((m) => m.id === e.turnMessageId);
          if (idx >= 0) {
            messages.value[idx] = {
              id: e.messageId,
              kind: e.kind === "system" ? "system" : "assistant",
              content: e.content,
              origin: e.origin,
              time: e.time,
              streaming: false,
            };
          } else {
            upsertMessage({ id: e.messageId, kind: "assistant" as const, content: e.content, origin: e.origin, time: e.time });
          }
          maybeSpeak(messages.value[messages.value.length - 1]);
        } else {
          const msg = { id: e.messageId, kind: "assistant" as const, content: e.content, origin: e.origin, time: e.time };
          upsertMessage(msg);
          maybeSpeak(msg);
        }
        break;
      case "chunk":
        appendChunk(e.messageId, e.delta);
        break;
      case "tool":
        if (e.status === "call") {
          tools.value.push({ name: e.name, status: "call", time: Date.now() });
        } else {
          const last = [...tools.value].reverse().find((t) => t.name === e.name && t.status === "call");
          if (last) last.status = "result";
          if (e.summary) {
            tools.value.push({ name: e.name, status: "result", summary: e.summary, time: Date.now() });
          }
        }
        break;
      case "turn":
        if (e.state === "end") {
          tools.value = [];
          for (const m of messages.value) {
            if (m.streaming) m.streaming = false;
          }
          if (e.reason && e.reason !== "completed") {
            error.value = `本轮对话结束（${e.reason}）`;
          }
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
      // 保持卡片可见，用户可重试
    }
  }

  // ---------- 连接 ----------
  async function refreshHealth() {
    try {
      const h = await health();
      healthInfo.value = h;
      busy.value = h.busy;
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      healthInfo.value = null;
    }
  }

  async function connect() {
    connecting.value = true;
    await refreshHealth();
    try {
      settingsInfo.value = await getSettings();
    } catch {
      /* 设置接口失败不阻断 */
    }
    try {
      const res = await fetch("/api/history");
      if (res.ok) {
        const data = (await res.json()) as { messages: ChatMessage[] };
        messages.value = data.messages.map((m) => ({ ...m, streaming: false }));
      }
    } catch {
      /* 历史拉取失败不阻断 */
    }
    connecting.value = false;
    openStream();
    scrollToBottom();
  }

  function openStream() {
    closeStream?.();
    closeStream = streamEvents(
      handleStreamEvent,
      (err) => {
        error.value = err instanceof Error ? err.message : String(err);
      },
    );
  }

  async function reconnect() {
    await refreshHealth();
    openStream();
  }

  // ---------- 发送 ----------
  async function send() {
    const content = composer.value.trim();
    if (!content) return;
    if (!canSend.value) return;
    composer.value = "";
    const localId = `local-${Date.now()}`;
    upsertMessage({ id: localId, kind: "user", content, origin: "user", time: Date.now() });
    busy.value = true;
    try {
      await sendChat(content);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      const idx = messages.value.findIndex((m) => m.id === localId);
      if (idx >= 0) messages.value.splice(idx, 1);
      busy.value = false;
    }
  }

  // ---------- 滚动 ----------
  function scrollToBottom() {
    nextTick(() => {
      const el = document.querySelector(".chat-scroll");
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  // ---------- 时间格式化 ----------
  function fmtTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  // ---------- 生命周期 ----------
  onMounted(() => {
    connect();
    const timer = window.setInterval(() => {
      refreshHealth();
    }, 8000);
    onBeforeUnmount(() => {
      window.clearInterval(timer);
      closeStream?.();
    });
  });

  return {
    healthInfo,
    settingsInfo,
    messages,
    tools,
    busy,
    connecting,
    error,
    composer,
    personaName,
    modelConfigured,
    currentModelLabel,
    statusText,
    canSend,
    setTtsSource,
    speakMessage,
    send,
    reconnect,
    pendingQuestion,
    submitQuestionAnswer,
    fmtTime,
  };
}
