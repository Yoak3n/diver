// 聊天核心状态装配（chat/ 子模块）：消息、工具、连接态、SSE 事件 → 本地状态。
// 不负责 HTTP/SSE 连接建立，也不负责发送；这些由 chat/transport 处理。
// 派生职责拆在 messageOps / activity / ttsBridge / streamEvents。

import { computed, ref } from "vue";
import type {
  ChatMessage,
  ComposerAttachment,
  HealthInfo,
  SettingsInfo,
  ToolActivity,
  UserQuestion,
} from "../../types";
import { createMessageOps } from "./messageOps";
import { createActivityOps } from "./activity";
import { createAttachmentOps, createTtsBridge } from "./ttsBridge";
import { createStreamHandler } from "./streamEvents";

export function createChatState() {
  // ---------- 状态 ----------
  const healthInfo = ref<HealthInfo | null>(null);
  const settingsInfo = ref<SettingsInfo | null>(null);
  const messages = ref<ChatMessage[]>([]);
  const tools = ref<ToolActivity[]>([]);
  /** step 占位 id → 最终消息 id（assistant/message 到达后仍能挂载后续 tool 事件）。 */
  const stepIdAlias = new Map<string, string>();
  const busy = ref(false);
  const connecting = ref(true);
  const error = ref<string | null>(null);
  const composer = ref("");
  const attachments = ref<ComposerAttachment[]>([]);
  const pendingQuestion = ref<{ requestId: string; questions: UserQuestion[] } | null>(null);

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
  const isReady = computed(
    () => !!healthInfo.value?.ok && modelConfigured.value && !connecting.value,
  );
  const canSend = computed(
    () => isReady.value && (composer.value.trim() !== "" || attachments.value.length > 0),
  );

  const ops = createMessageOps(messages, stepIdAlias);
  const activity = createActivityOps(messages, ops.scrollToBottom);
  const tts = createTtsBridge();
  const attachOps = createAttachmentOps(attachments);
  const stream = createStreamHandler({
    healthInfo,
    messages,
    tools,
    busy,
    error,
    pendingQuestion,
    stepIdAlias,
    upsertMessage: ops.upsertMessage,
    appendChunk: ops.appendChunk,
    appendThinking: ops.appendThinking,
    attachTool: ops.attachTool,
    maybeSpeak: tts.maybeSpeak,
    collapseTurnActivity: activity.collapseTurnActivity,
  });

  function fmtTime(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  return {
    healthInfo,
    settingsInfo,
    messages,
    tools,
    busy,
    connecting,
    error,
    composer,
    attachments,
    pendingQuestion,
    personaName,
    modelConfigured,
    currentModelLabel,
    statusText,
    isReady,
    canSend,
    addAttachments: attachOps.addAttachments,
    removeAttachment: attachOps.removeAttachment,
    clearAttachments: attachOps.clearAttachments,
    setTtsSource: tts.setTtsSource,
    speakMessage: tts.speakMessage,
    upsertMessage: ops.upsertMessage,
    handleStreamEvent: stream.handleStreamEvent,
    collapseTurnActivity: activity.collapseTurnActivity,
    toggleActivity: activity.toggleActivity,
    scrollToBottom: ops.scrollToBottom,
    fmtTime,
  };
}
