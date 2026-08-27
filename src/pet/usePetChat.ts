// 桌宠轻量聊天：只保留最近几条消息 + 发送 + SSE 事件流（与主窗口并存）

import { computed, onBeforeUnmount, ref } from "vue";
import { answerQuestion, getHistory, getSettings, health, sendChat, streamEvents } from "../api";
import type { ChatMessage, StreamEvent, UserQuestion, UserQuestionAnswerItem } from "../types";
import { onTauriEvent, tauriAvailable, waitForSidecarReady } from "../tauri";

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
  /** 历史成功加载一次后不再重复拉取（hello / 状态事件 / 健康轮询都会触发重试）。 */
  let historyLoaded = false;

  const canSend = computed(() => connected.value && !busy.value);

  /**
   * 拉取最近会话历史（幂等）。
   * 首次启动时桌宠页面可能先于 sidecar 就绪，单次拉取会静默失败；
   * 这里由三路信号重试：SSE hello、sidecar://status running、健康轮询恢复。
   */
  async function loadHistory() {
    if (historyLoaded) return;
    try {
      const data = await getHistory();
      // 仅当本地还没有消息时填充，避免覆盖正在进行的会话
      if (messages.value.length === 0) {
        // 历史消息标记 fromHistory：气泡/朗读等"新消息到达提示"不得重放上次会话末尾。
        messages.value = data.messages.slice(-MAX_MESSAGES).map((m) => ({ ...m, streaming: false, fromHistory: true }));
      }
      historyLoaded = true;
    } catch {
      /* sidecar 尚未就绪：由 hello / sidecar://status / 健康轮询重试 */
    }
  }

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
        // SSE 流建立说明 sidecar HTTP 已就绪：补拉历史（幂等）
        void loadHistory();
        break;
      case "message":
        if (e.kind === "user") {
          // 去重：send() 已本地 push 一条 local- 前缀消息，服务端回传同一条时
          // 替换本地消息（拿到服务端 id），而不是再 push 一条造成重复。
          const localIdx = messages.value.findIndex(
            (m) =>
              m.id.startsWith("local-") &&
              m.kind === "user" &&
              m.content === e.content &&
              // 只匹配 3 秒内发送的本地消息，避免误合并历史同文消息
              Date.now() - m.time < 3000,
          );
          if (localIdx >= 0) {
            messages.value[localIdx] = {
              ...messages.value[localIdx],
              id: e.messageId,
              time: e.time,
              origin: e.origin ?? "user",
            };
          } else {
            push({ id: e.messageId, kind: "user", content: e.content, origin: "user", time: e.time });
          }
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
          } else if (e.content !== "") {
            push({ id: e.messageId, kind: "assistant", content: e.content, origin: e.origin, time: e.time });
          }
        } else {
          // 无占位消息的最终消息：跳过空内容（纯工具步骤等），避免空气泡
          if (e.content === "") break;
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
    // 先等后端就绪（backend://ready + 状态查询兜底），再发起首轮请求；
    // 超时降级由 hello / sidecar://status / 健康轮询的幂等重试兜底。
    const ready = await waitForSidecarReady();
    if (!ready) {
      console.warn("[pet] 等待 sidecar 就绪超时，降级为重试模式");
    }
    await loadHistory();
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

  /** 探活：sidecar 恢复后自动重开事件流 + 补拉历史。 */
  async function refreshHealth() {
    try {
      const h = await health();
      connected.value = true;
      error.value = null;
      busy.value = h.busy;
      // 健康恢复说明 sidecar 已就绪：补拉历史（幂等）
      void loadHistory();
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
      void onTauriEvent<import("../types").SidecarStatus>("sidecar://status", (status) => {
        // 状态为 running（DIVER_READY）时补拉历史，修复启动竞态
        if (status.state === "running") void loadHistory();
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
