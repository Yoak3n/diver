// 桌宠轻量聊天：传输与探活（历史拉取 / SSE 流 / 发送 / 健康轮询 / 设置同步）。

import { answerQuestion, getHistory, health, sendChat, streamEvents } from "../../api";
import type { ChatImage, UserQuestionAnswerItem } from "../../types";
import { onTauriEvent, tauriAvailable, waitForSidecarReady } from "../../tauri";
import { hasVisibleMessageBody } from "../../markdown";
import { mergeHistoryIntoPool } from "../../composables/chat/reconcile";
import { createEventHandler, type EventHooks } from "./events";
import type { PetChatState } from "./state";

/** 打开时只加载最近几轮对话（与主窗口一致，更早的懒加载）。 */
const INITIAL_ROUNDS = 2;
/** 懒加载单块条数。 */
const OLDER_CHUNK_LIMIT = 60;
const HEALTH_POLL_MS = 8000;

export interface PetChatIo {
  loadHistory: () => Promise<void>;
  loadOlder: () => Promise<void>;
  connect: () => Promise<void>;
  send: () => Promise<void>;
  submitQuestionAnswer: (answers: UserQuestionAnswerItem[]) => Promise<void>;
  startAutoRefresh: () => void;
  /** 卸载清理：定时器 / 事件订阅 / SSE 流。 */
  dispose: () => void;
}

export function createPetChatIo(
  state: PetChatState,
  getInstanceId?: () => string | undefined,
  maybeSpeak?: EventHooks["maybeSpeak"],
): PetChatIo {
  const { messages, busy, connected, error, composer, attachments, ttsEnabled, ttsVoice, pendingQuestion, historyHasMore, loadingOlder, isReady, push, clearAttachments } = state;

  let closeStream: (() => void) | null = null;
  let streamOpen = false;
  let healthTimer: number | null = null;
  let stopSidecarEvent: (() => void) | null = null;
  /** 历史成功加载一次后不再重复拉取（hello / 状态事件 / 健康轮询都会触发重试）。 */
  let historyLoaded = false;

  /**
   * 拉取最近会话历史（幂等）：只取最近 INITIAL_ROUNDS 轮，更早的靠 loadOlder 补。
   * 首次启动时桌宠页面可能先于 sidecar 就绪，单次拉取会静默失败；
   * 这里由三路信号重试：SSE hello、sidecar://status running、健康轮询恢复。
   */
  async function loadHistory() {
    if (historyLoaded) return;
    try {
      const data = await getHistory(getInstanceId?.(), { rounds: INITIAL_ROUNDS });
      // 仅当本地还没有消息时填充，避免覆盖正在进行的会话
      if (messages.value.length === 0) {
        // 历史消息标记 fromHistory：气泡/朗读等"新消息到达提示"不得重放上次会话末尾。
        // 先滤掉无正文/无图的工具·思考步骤与他方实例来讯（peer），避免空气泡与误标「我」。
        messages.value = data.messages
          .filter((m) => m.origin !== "peer" && hasVisibleMessageBody(m))
          .map((m) => ({ ...m, streaming: false, fromHistory: true }));
        historyHasMore.value = data.hasMore === true;
      }
      historyLoaded = true;
    } catch {
      /* sidecar 尚未就绪：由 hello / sidecar://status / 健康轮询重试 */
    }
  }

  /** 懒加载更早的消息：以池内最旧一条为锚点向前取一块（去重后按时间前插）。 */
  async function loadOlder() {
    if (loadingOlder.value || !historyHasMore.value) return;
    const anchor = messages.value[0];
    if (!anchor || anchor.id.startsWith("local-")) return;
    loadingOlder.value = true;
    try {
      const data = await getHistory(getInstanceId?.(), {
        before: anchor.id,
        beforeTime: anchor.time,
        limit: OLDER_CHUNK_LIMIT,
      });
      const { merged, added } = mergeHistoryIntoPool(
        messages.value,
        data.messages.filter((m) => m.origin !== "peer" && hasVisibleMessageBody(m)),
      );
      if (added > 0) messages.value = merged;
      historyHasMore.value = data.hasMore === true;
    } catch {
      /* 拉取失败：保留锚点，下次触发再试 */
    } finally {
      loadingOlder.value = false;
    }
  }

  const handleEvent = createEventHandler(state, { loadHistory, maybeSpeak });

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
      getInstanceId?.(),
    );
  }

  /** 探活：sidecar 恢复后自动重开事件流 + 补拉历史。 */
  async function refreshHealth() {
    try {
      const h = await health(getInstanceId?.());
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
      // TTS 开关/声线来自壳层在线 TTS 配置（tts.json）
      const { getTtsConfig } = await import("../../tauri");
      const cfg = await getTtsConfig();
      ttsEnabled.value = !!cfg.enabled;
      ttsVoice.value = cfg.voice ?? "";
    } catch {
      /* 设置读取失败不阻断 */
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

  function startAutoRefresh() {
    healthTimer = window.setInterval(() => {
      void refreshHealth();
    }, HEALTH_POLL_MS);
    // Tauri 环境：sidecar 状态变化（启动/停止/重启）时立即刷新
    if (tauriAvailable()) {
      void onTauriEvent<import("../../types").SidecarStatus>("sidecar://status", (status) => {
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
    const images: ChatImage[] = attachments.value.map((a) => ({
      mime: a.mime,
      data: a.data,
      ...(a.name !== undefined ? { name: a.name } : {}),
    }));
    if (!content && images.length === 0) return;
    if (!isReady.value) return;
    composer.value = "";
    clearAttachments();
    const localId = `local-${Date.now()}`;
    push({
      id: localId,
      kind: "user",
      content,
      origin: "user",
      time: Date.now(),
      ...(images.length > 0 ? { images } : {}),
    });
    busy.value = true;
    try {
      const res = await sendChat(content, images, getInstanceId?.());
      // 发送成功即绑定服务端消息 id：中途发送走 steer，正式 user/message 事件
      // 可能远晚于 3s 回声窗口——靠 id 原地替换才不会渲染两条。
      if (res?.messageId) {
        const idx = messages.value.findIndex((m) => m.id === localId);
        if (idx >= 0) messages.value[idx] = { ...messages.value[idx], id: res.messageId };
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      busy.value = false;
    }
  }

  /** 提交对 ask_user_question 的回答。 */
  async function submitQuestionAnswer(answers: UserQuestionAnswerItem[]) {
    const q = pendingQuestion.value;
    if (!q) return;
    try {
      await answerQuestion(q.requestId, answers, getInstanceId?.());
      pendingQuestion.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  function dispose() {
    if (healthTimer !== null) window.clearInterval(healthTimer);
    stopSidecarEvent?.();
    closeStream?.();
  }

  return { loadHistory, loadOlder, connect, send, submitQuestionAnswer, startAutoRefresh, dispose };
}
