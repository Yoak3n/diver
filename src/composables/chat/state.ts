// 聊天核心状态（chat/ 子模块）：消息、工具、连接态、SSE 事件 → 本地状态。
// 不负责 HTTP/SSE 连接建立，也不负责发送；这些由 chat/transport 处理。

import { computed, nextTick, ref } from "vue";
import type {
  ChatMessage,
  ComposerAttachment,
  HealthInfo,
  SettingsInfo,
  StreamEvent,
  ToolActivity,
  UserQuestion,
} from "../../types";
import { speakMessageText } from "../../tts";

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
  /** 输入框待发送图片附件（拖入 / 粘贴截图 / 文件选择）。 */
  const attachments = ref<ComposerAttachment[]>([]);
  /** 模型通过 ask_user_question 提出的问题（待用户回答）。 */
  const pendingQuestion = ref<{ requestId: string; questions: UserQuestion[] } | null>(null);
  let ttsSource: (() => { enabled: boolean; voice: string } | null) | null = null;

  // ---------- 派生 ----------
  // 不预设名字：health 的 persona 字段保留扩展点（未来可让用户自定义名字），
  // 为空时 UI 走无人称样式（不显示名字）。
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
  /** 连接/模型就绪（状态灯、占位符用）。 */
  const isReady = computed(
    () => !!healthInfo.value?.ok && modelConfigured.value && !connecting.value,
  );
  /** 本次草稿可发送（有文字或图片，且就绪）。 */
  const canSend = computed(
    () => isReady.value && (composer.value.trim() !== "" || attachments.value.length > 0),
  );

  /** 加入待发送图片（预览 URL 仅本地使用；发送走 base64）。 */
  function addAttachments(items: ComposerAttachment[]) {
    for (const item of items) {
      if (attachments.value.length >= 8) break;
      attachments.value.push(item);
    }
  }

  function removeAttachment(id: string) {
    const idx = attachments.value.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const [gone] = attachments.value.splice(idx, 1);
    try {
      URL.revokeObjectURL(gone.previewUrl);
    } catch {
      /* 忽略 */
    }
  }

  function clearAttachments() {
    for (const a of attachments.value) {
      try {
        URL.revokeObjectURL(a.previewUrl);
      } catch {
        /* 忽略 */
      }
    }
    attachments.value = [];
  }

  // ---------- TTS 源注入（由 useSettings 提供开关与语音） ----------
  function setTtsSource(fn: () => { enabled: boolean; voice: string } | null): void {
    ttsSource = fn;
  }

  async function maybeSpeak(msg?: ChatMessage) {
    if (!msg || msg.kind !== "assistant" || msg.streaming) return;
    // 历史加载 / 重启恢复：不朗读，避免旧句被反复重放
    if (msg.fromHistory) return;
    const tts = ttsSource?.();
    if (!tts?.enabled || !msg.content.trim()) return;
    try {
      // 带 messageId 去重：主窗口与桌宠同时在线时只读一遍
      await speakMessageText(msg.content, tts.voice, msg.id);
    } catch {
      /* TTS 不可用时不打扰 */
    }
  }

  async function speakMessage(msg: ChatMessage) {
    const tts = ttsSource?.();
    // 手动朗读：force 跳过去重
    await speakMessageText(msg.content, tts?.voice ?? "", msg.id, { force: true, userGesture: true });
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

  /** 深度思考流：与正文分轨，挂到同 step 的消息上（默认折叠展示）。 */
  function appendThinking(messageId: string, delta: string) {
    const idx = messages.value.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      const m = messages.value[idx];
      m.thinking = (m.thinking ?? "") + delta;
      m.thinkingStreaming = true;
    } else {
      messages.value.push({
        id: messageId,
        kind: "assistant",
        content: "",
        origin: "assistant",
        time: Date.now(),
        streaming: true,
        thinking: delta,
        thinkingStreaming: true,
      });
    }
    scrollToBottom();
  }

  /** 把工具调用/结果挂到对应 step 的消息上（保持时间线顺序）。 */
  function attachTool(messageId: string, tool: ToolActivity) {
    const id = stepIdAlias.get(messageId) ?? messageId;
    let idx = messages.value.findIndex((m) => m.id === id);
    if (idx < 0) {
      messages.value.push({
        id,
        kind: "assistant",
        content: "",
        origin: "assistant",
        time: tool.time,
        streaming: true,
        tools: [{ ...tool }],
      });
      scrollToBottom();
      return;
    }
    const m = messages.value[idx];
    const list = m.tools ? m.tools.map((t) => ({ ...t })) : [];
    if (tool.status === "result") {
      const i = tool.callId !== undefined
        ? list.findIndex((t) => t.callId === tool.callId && t.status === "call")
        : [...list].reverse().findIndex((t) => t.name === tool.name && t.status === "call");
      const hit = i >= 0 ? (tool.callId !== undefined ? i : list.length - 1 - i) : -1;
      if (hit >= 0) {
        list[hit] = {
          ...list[hit],
          status: "result",
          ...(tool.summary !== undefined ? { summary: tool.summary } : {}),
          ...(tool.isError !== undefined ? { isError: tool.isError } : {}),
        };
      } else {
        list.push({ ...tool });
      }
    } else {
      list.push({ ...tool });
    }
    messages.value[idx] = { ...m, tools: list };
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
        error.value = null;
        break;
      case "message":
        if (e.kind === "user") {
          // 仅把「3s 内的本窗乐观预览」换成服务端 id；桌宠等其它来源的新消息必须 upsert，
          // 否则同文 local- 残留会被误判为重复，导致这条用户消息从主窗口消失。
          const localIdx = messages.value.findIndex(
            (m) =>
              m.kind === "user" &&
              m.content === e.content &&
              m.id.startsWith("local-") &&
              (m.images?.length ?? 0) === (e.images?.length ?? 0) &&
              Date.now() - m.time < 3000,
          );
          if (localIdx >= 0) {
            messages.value[localIdx] = {
              ...messages.value[localIdx],
              id: e.messageId,
              ...(e.images !== undefined && e.images.length > 0 ? { images: e.images } : {}),
            };
          } else {
            upsertMessage({
              id: e.messageId,
              kind: "user",
              content: e.content,
              origin: e.origin ?? "user",
              time: e.time,
              ...(e.images !== undefined && e.images.length > 0 ? { images: e.images } : {}),
            });
          }
        } else if (e.kind === "system") {
          // presence / 桌宠互动：折叠行，不进 TTS
          upsertMessage({
            id: e.messageId,
            kind: "system",
            content: e.content,
            origin: e.origin,
            time: e.time,
          });
        } else if (e.turnMessageId) {
          const idx = messages.value.findIndex((m) => m.id === e.turnMessageId);
          const existing = idx >= 0 ? messages.value[idx] : undefined;
          const existingThinking = existing?.thinking;
          const existingTools = existing?.tools;
          if (idx >= 0) {
            messages.value[idx] = {
              id: e.messageId,
              kind: "assistant",
              content: e.content,
              origin: e.origin,
              time: e.time,
              streaming: false,
              ...(existingThinking !== undefined && existingThinking !== ""
                ? { thinking: existingThinking, thinkingStreaming: false }
                : {}),
              ...(existingTools !== undefined && existingTools.length > 0
                ? { tools: existingTools }
                : {}),
            };
            stepIdAlias.set(e.turnMessageId, e.messageId);
          } else if (e.content !== "") {
            upsertMessage({ id: e.messageId, kind: "assistant" as const, content: e.content, origin: e.origin, time: e.time });
          }
          maybeSpeak(messages.value[messages.value.length - 1]);
        } else {
          // 无占位消息的最终消息：跳过空内容（纯工具步骤等），避免空气泡；
          // 但有思考或工具记录时仍保留（dsh 风格：思考/工具行独立展示）。
          const existing = messages.value.find((m) => m.id === e.messageId);
          const thinking = existing?.thinking;
          const tools = existing?.tools;
          const hasMeta =
            (thinking !== undefined && thinking !== "") ||
            (tools !== undefined && tools.length > 0);
          if (e.content === "" && !hasMeta) break;
          const msg = {
            id: e.messageId,
            kind: "assistant" as const,
            content: e.content,
            origin: e.origin,
            time: e.time,
            ...(thinking !== undefined && thinking !== ""
              ? { thinking, thinkingStreaming: false }
              : {}),
            ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
          };
          upsertMessage(msg);
          maybeSpeak(msg);
        }
        break;
      case "chunk":
        appendChunk(e.messageId, e.delta);
        break;
      case "thinking":
        appendThinking(e.messageId, e.delta);
        break;
      case "tool": {
        const tool: ToolActivity = {
          name: e.name,
          status: e.status,
          time: Date.now(),
          ...(e.summary !== undefined ? { summary: e.summary } : {}),
          ...(e.callId !== undefined ? { callId: e.callId } : {}),
          ...(e.isError !== undefined ? { isError: e.isError } : {}),
        };
        // 底部活动条：仅展示进行中/本轮最近工具
        if (e.status === "call") {
          tools.value.push({ ...tool });
        } else {
          const last = [...tools.value].reverse().find((t) => t.name === e.name && t.status === "call");
          if (last) last.status = "result";
          if (e.summary) {
            tools.value.push({ ...tool });
          }
        }
        // 消息时间线：按 step 挂载，turn 结束后仍可回看
        if (e.messageId) attachTool(e.messageId, tool);
        break;
      }
      case "turn":
        if (e.state === "end") {
          tools.value = [];
          for (const m of messages.value) {
            if (m.streaming) m.streaming = false;
            if (m.thinkingStreaming) m.thinkingStreaming = false;
          }
          // 最终输出到位后：把本轮过程（思考/工具/中间步骤）收成「N 次工具调用 · M 条消息」
          collapseTurnActivity();
          if (e.reason === "max-tokens") {
            error.value = "本轮回复被输出长度上限截断了，可发送「继续」补完";
          } else if (e.reason && e.reason !== "completed") {
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

  // ---------- 本轮过程折叠（最终输出后收起思考/工具） ----------
  /**
   * 把每一轮「用户 → 过程（思考/工具/中间步骤）→ 最终答复」里的过程
   * 收成一条 activity-summary（默认折叠）。从后往前扫，避免插入 summary
   * 后下标漂移；已折叠过的轮次（成员带 activityGroupId）会跳过。
   */
  function collapseTurnActivity() {
    const list = messages.value;
    if (list.length === 0) return;

    let turnEnd = list.length;
    while (turnEnd > 0) {
      // 本段起点：turnEnd 之前最近的一条用户消息之后
      let userIdx = -1;
      for (let i = turnEnd - 1; i >= 0; i--) {
        if (list[i].kind === "user") {
          userIdx = i;
          break;
        }
      }
      const start = userIdx + 1;
      if (start >= turnEnd) {
        turnEnd = userIdx;
        if (userIdx < 0) break;
        continue;
      }

      // 最终答复 = 本段最后一条带正文、且尚未归入活动组的 assistant
      let finalIdx = -1;
      for (let i = turnEnd - 1; i >= start; i--) {
        const m = list[i];
        if (m.kind === "assistant" && m.content.trim() !== "" && !m.activityGroupId) {
          finalIdx = i;
          break;
        }
      }
      if (finalIdx < 0) {
        turnEnd = userIdx;
        if (userIdx < 0) break;
        continue;
      }

      // 过程成员：最终答复之前；用户/系统行永不折叠，否则桌宠发的用户消息会被藏进汇总
      const members: ChatMessage[] = [];
      for (let i = start; i < finalIdx; i++) {
        const m = list[i];
        if (m.kind === "activity-summary" || m.kind === "user" || m.kind === "system" || m.activityGroupId) {
          continue;
        }
        members.push(m);
      }

      let toolCount = 0;
      for (const m of members) {
        toolCount += m.tools?.length ?? 0;
      }
      const messageCount = members.length;
      // 无工具且过程不足 2 条时不必折叠
      if (!(toolCount === 0 && messageCount <= 1) && members.length > 0) {
        const groupId = `act-${Date.now()}-${turnEnd}`;
        for (const m of members) {
          m.activityGroupId = groupId;
        }
        const summary: ChatMessage = {
          id: groupId,
          kind: "activity-summary",
          content: "",
          origin: "assistant",
          time: members[0].time,
          toolCount,
          messageCount,
          activityExpanded: false,
          activityGroupId: groupId,
        };
        const insertAt = list.indexOf(members[0]);
        list.splice(insertAt, 0, summary);
      }

      turnEnd = userIdx;
      if (userIdx < 0) break;
    }
    scrollToBottom();
  }

  /** 切换活动组展开/收起。 */
  function toggleActivity(groupId: string) {
    const summary = messages.value.find(
      (m) => m.kind === "activity-summary" && m.activityGroupId === groupId,
    );
    if (!summary) return;
    summary.activityExpanded = !summary.activityExpanded;
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
    addAttachments,
    removeAttachment,
    clearAttachments,
    setTtsSource,
    speakMessage,
    upsertMessage,
    handleStreamEvent,
    collapseTurnActivity,
    toggleActivity,
    scrollToBottom,
    fmtTime,
  };
}
