// 聊天传输层（chat/ 子模块）：HTTP/SSE 连接、健康检查、发送、回答提问。
// 不持有消息/工具等 UI 状态；状态由 chat/state 提供。

import { answerQuestion, getSettings, health, sendChat, streamEvents } from "../../api";
import { onTauriEvent, tauriAvailable, waitForSidecarReady } from "../../tauri";
import type { ChatMessage, UserQuestionAnswerItem } from "../../types";
import type { createChatState } from "./state";

export type ChatState = ReturnType<typeof createChatState>;

export function createChatTransport(state: ChatState) {
  let closeStream: (() => void) | null = null;
  let stopSidecarEvent: (() => void) | null = null;
  /** 历史成功加载一次后不再重复拉取（hello / 状态事件 / 健康轮询都会触发重试）。 */
  let historyLoaded = false;

  /**
   * 拉取当前会话历史（幂等）。
   * 首次 Dev 启动时 WebView 可能先于 sidecar 就绪，单次拉取会静默失败；
   * 这里由三路信号重试：SSE hello、sidecar://status running、健康轮询恢复。
   */
  async function loadHistory() {
    if (historyLoaded) return;
    try {
      const res = await fetch("/api/history");
      if (!res.ok) return;
      const data = (await res.json()) as { messages: ChatMessage[] };
      // 仅当本地还没有消息时填充，避免覆盖正在进行的会话
      if (state.messages.value.length === 0) {
        state.messages.value = data.messages.map((m) => ({ ...m, streaming: false }));
        // 历史里的完整轮次同样默认折叠过程活动
        state.collapseTurnActivity();
      }
      historyLoaded = true;
    } catch {
      /* sidecar 尚未就绪：由 hello / sidecar://status / 健康轮询重试 */
    }
  }

  async function refreshHealth() {
    try {
      const h = await health();
      state.healthInfo.value = h;
      state.busy.value = h.busy;
      state.error.value = null;
      // 健康恢复说明 sidecar 已就绪：补拉历史（幂等）
      void loadHistory();
    } catch (err) {
      state.error.value = err instanceof Error ? err.message : String(err);
      state.healthInfo.value = null;
    }
  }

  async function connect() {
    state.connecting.value = true;
    // 先等后端就绪（Rust 侧 backend://ready 事件 + 状态查询兜底），
    // 再发起首轮请求，避免 WebView 先于 sidecar 挂载时请求打在未监听端口上。
    const ready = await waitForSidecarReady();
    if (!ready) {
      // 就绪超时：仍走一次请求流程，失败由 refreshHealth/loadHistory 的
      // 幂等重试（hello / sidecar://status / 健康轮询）兜底。
      console.warn("[chat] 等待 sidecar 就绪超时，降级为重试模式");
    }
    await refreshHealth();
    try {
      state.settingsInfo.value = await getSettings();
    } catch {
      /* 设置接口失败不阻断 */
    }
    await loadHistory();
    state.connecting.value = false;
    openStream();
    state.scrollToBottom();

    // Tauri 环境：sidecar 状态变为 running（DIVER_READY）时立即补拉历史与设置，
    // 修复首次启动 / 插件启停重启后 WebView 状态陈旧（需手动刷新页面）的问题。
    if (!stopSidecarEvent && tauriAvailable()) {
      void onTauriEvent<import("../../types").SidecarStatus>("sidecar://status", (status) => {
        if (status.state !== "running") return;
        void loadHistory();
        void refreshHealth();
        void getSettings()
          .then((s) => {
            state.settingsInfo.value = s;
          })
          .catch(() => {});
      }).then((unlisten) => {
        stopSidecarEvent = unlisten;
      });
    }
  }

  function openStream() {
    closeStream?.();
    closeStream = streamEvents(
      (e) => {
        // SSE 流建立（hello）说明 sidecar HTTP 已就绪：补拉历史（幂等）
        if (e.type === "hello") void loadHistory();
        state.handleStreamEvent(e);
      },
      (err) => {
        state.error.value = err instanceof Error ? err.message : String(err);
      },
    );
  }

  async function reconnect() {
    await refreshHealth();
    try {
      state.settingsInfo.value = await getSettings();
    } catch {
      /* 设置接口失败不阻断 */
    }
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
    stopSidecarEvent?.();
    stopSidecarEvent = null;
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
