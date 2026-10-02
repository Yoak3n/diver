// 聊天传输层（chat/ 子模块）：HTTP/SSE 连接、健康检查、发送、回答提问。
// 按实例寻址（P2-3 私聊）：state 之外固定 instanceId，端点全部带上。
// 不持有消息/工具等 UI 状态；状态由 chat/state 提供。

import { answerQuestion, getHistory, getSettings, health, sendChat, streamEvents } from "../../api";
import { onTauriEvent, tauriAvailable, waitForSidecarReady } from "../../tauri";
import type { ChatImage, SidecarStatus, UserQuestionAnswerItem } from "../../types";
import { mergeHistoryIntoPool, stripActivityFolds } from "./reconcile";
import type { createChatState } from "./state";

export type ChatState = ReturnType<typeof createChatState>;

/** 打开时只加载最近几轮对话（用户拍板：最后一两轮，更早的懒加载）。 */
const INITIAL_ROUNDS = 2;
/** 上翻懒加载的单段条数（用户拍板 2026-09-29：加载更多要分段给，不能一次铺完剩余）。 */
const OLDER_CHUNK_LIMIT = 20;

export function createChatTransport(state: ChatState, instanceId: string) {
  let closeStream: (() => void) | null = null;
  let stopSidecarEvent: (() => void) | null = null;
  let healthTimer: number | null = null;
  /** 历史成功加载一次后不再重复拉取（hello / 状态事件 / 健康轮询都会触发重试）。 */
  let historyLoaded = false;

  /**
   * 拉取当前会话历史（幂等）：只取最近 INITIAL_ROUNDS 轮，更早的靠 loadOlder 补。
   * 首次 Dev 启动时 WebView 可能先于 sidecar 就绪，单次拉取会静默失败；
   * 这里由三路信号重试：SSE hello、sidecar://status running、健康轮询恢复。
   */
  async function loadHistory() {
    if (historyLoaded) return;
    try {
      const data = await getHistory(instanceId, { rounds: INITIAL_ROUNDS });
      // 仅当本地还没有消息时填充，避免覆盖正在进行的会话
      if (state.messages.value.length === 0) {
        state.messages.value = data.messages.map((m) => ({ ...m, streaming: false }));
        // 历史里的完整轮次同样默认折叠过程活动
        state.collapseTurnActivity();
        state.historyHasMore.value = data.hasMore === true;
      }
      historyLoaded = true;
    } catch {
      /* sidecar 尚未就绪：由 hello / sidecar://status / 健康轮询重试 */
    }
  }

  /**
   * hello 对账（SSE 每次建立都会触发，含断线自动重连）：
   * 空池走常规历史填充；非空池只补最近几轮里 SSE 断缝漏掉的消息（按 id/内容
   * 时间去重），闲时拆掉旧折叠重建（缺口可能正卡在折叠组的轮次边界上），
   * 忙时只补不重排，避免打断正在流式的占位气泡。
   * 更早区间的缺口不在此补：用户上翻懒加载时服务端会按锚点重建，缺口自愈。
   */
  async function reconcileOnHello() {
    if (state.messages.value.length === 0) {
      await loadHistory();
      return;
    }
    try {
      const data = await getHistory(instanceId, { rounds: INITIAL_ROUNDS });
      const { merged, added } = mergeHistoryIntoPool(state.messages.value, data.messages);
      state.historyHasMore.value = data.hasMore === true;
      if (added === 0) return;
      state.messages.value = state.busy.value ? merged : stripActivityFolds(merged);
      if (!state.busy.value) state.collapseTurnActivity();
    } catch {
      /* 历史暂不可得：下次 hello / 健康轮询再试 */
    }
  }

  /**
   * 懒加载更早的消息（滚动到顶 / 导航触发）：以池内最旧一条为锚点向前取一块，
   * 按时间原位前插（复用对账合并的去重）。并发与重复触发由 loadingOlder 挡住。
   */
  async function loadOlder() {
    if (state.loadingOlder.value || !state.historyHasMore.value) return;
    const anchor = state.messages.value[0];
    if (!anchor || anchor.id.startsWith("local-")) return;
    state.loadingOlder.value = true;
    try {
      const data = await getHistory(instanceId, {
        before: anchor.id,
        beforeTime: anchor.time,
        limit: OLDER_CHUNK_LIMIT,
      });
      const { merged, added } = mergeHistoryIntoPool(state.messages.value, data.messages);
      if (added > 0) state.messages.value = merged;
      state.historyHasMore.value = data.hasMore === true;
    } catch {
      /* 拉取失败：保留锚点，下次触发再试 */
    } finally {
      state.loadingOlder.value = false;
    }
  }

  async function refreshHealth() {
    try {
      const h = await health(instanceId);
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
      console.warn(`[chat] 等待 sidecar 就绪超时（${instanceId}），降级为重试模式`);
    }
    await refreshHealth();
    try {
      state.settingsInfo.value = await getSettings(instanceId);
    } catch {
      /* 设置接口失败不阻断 */
    }
    await loadHistory();
    state.connecting.value = false;
    openStream();
    state.scrollToBottom();

    // 健康轮询（每会话一份）：驱动历史补拉与断线恢复。
    if (healthTimer === null) {
      healthTimer = window.setInterval(() => {
        void refreshHealth();
      }, 8000);
    }

    // Tauri 环境：本实例 sidecar 状态变为 running（DIVER_READY）时立即补拉历史与设置，
    // 修复首次启动 / 插件启停重启后 WebView 状态陈旧（需手动刷新页面）的问题。
    // P2-3：事件全实例广播（payload 带 id），按 instanceId 过滤。
    if (!stopSidecarEvent && tauriAvailable()) {
      void onTauriEvent<SidecarStatus>("sidecar://status", (status) => {
        if (status.state !== "running" || status.id !== instanceId) return;
        void loadHistory();
        void refreshHealth();
        void getSettings(instanceId)
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
        // SSE 流建立（hello）说明 sidecar HTTP 已就绪：对账补缺（幂等，含空池首拉）
        if (e.type === "hello") void reconcileOnHello();
        state.handleStreamEvent(e);
      },
      (err) => {
        state.error.value = err instanceof Error ? err.message : String(err);
      },
      instanceId,
    );
  }

  async function reconnect() {
    await refreshHealth();
    try {
      state.settingsInfo.value = await getSettings(instanceId);
    } catch {
      /* 设置接口失败不阻断 */
    }
    openStream();
  }

  async function send(opts?: {
    content?: string;
    images?: ChatImage[];
    queue?: boolean;
    group?: { id: string; name: string };
    clientMsgId?: string;
  }) {
    // 显式参数 = 群聊广播外发（P2-3/P2-4）：纯投递，不动本地 composer/busy；
    // SSE 回声带 group 标，由合并流去重只渲染一条。
    if (opts?.content !== undefined) {
      const text = opts.content.trim();
      const images = opts.images ?? [];
      if (!text && images.length === 0) return;
      await sendChat(text, images, instanceId, {
        queue: opts.queue === true,
        ...(opts.group ? { group: opts.group } : {}),
        ...(opts.clientMsgId ? { clientMsgId: opts.clientMsgId } : {}),
      });
      return;
    }
    const content = state.composer.value.trim();
    const images = state.attachments.value.map((a) => ({
      mime: a.mime,
      data: a.data,
      ...(a.name !== undefined ? { name: a.name } : {}),
    }));
    if (!content && images.length === 0) return;
    if (!state.canSend.value) return;
    const previewImages = state.attachments.value.map((a) => ({
      mime: a.mime,
      data: a.data,
      ...(a.name !== undefined ? { name: a.name } : {}),
    }));
    state.composer.value = "";
    state.clearAttachments();
    const localId = `local-${Date.now()}`;
    state.upsertMessage({
      id: localId,
      kind: "user",
      content,
      origin: "user",
      time: Date.now(),
      ...(previewImages.length > 0 ? { images: previewImages } : {}),
    });
    state.busy.value = true;
    try {
      const res = await sendChat(content, images, instanceId);
      // 发送成功即用服务端消息 id 原地改名：中途发送走 steer/队列，正式
      // user/message 事件可能远晚于 3s 回声窗口——靠 id 才能原地替换不重发。
      if (res?.messageId) {
        const idx = state.messages.value.findIndex((m) => m.id === localId);
        if (idx >= 0) state.messages.value[idx] = { ...state.messages.value[idx], id: res.messageId };
      }
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
      await answerQuestion(q.requestId, answers, instanceId);
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
    if (healthTimer !== null) {
      window.clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  return {
    refreshHealth,
    connect,
    openStream,
    reconnect,
    send,
    loadOlder,
    submitQuestionAnswer,
    dispose,
    instanceId,
  };
}
