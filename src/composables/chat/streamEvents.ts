// SSE StreamEvent → 本地聊天状态。

import type { Ref } from "vue";
import type {
  ChatMessage,
  HealthInfo,
  StreamEvent,
  ToolActivity,
  UserQuestion,
} from "../../types";
import { sameUserEcho } from "./echo";

type Deps = {
  healthInfo: Ref<HealthInfo | null>;
  messages: Ref<ChatMessage[]>;
  tools: Ref<ToolActivity[]>;
  busy: Ref<boolean>;
  error: Ref<string | null>;
  pendingQuestion: Ref<{ requestId: string; questions: UserQuestion[] } | null>;
  stepIdAlias: Map<string, string>;
  upsertMessage: (msg: Omit<ChatMessage, "streaming"> & { streaming?: boolean }) => void;
  appendChunk: (messageId: string, delta: string) => void;
  appendThinking: (messageId: string, delta: string) => void;
  attachTool: (messageId: string, tool: ToolActivity) => void;
  maybeSpeak: (msg?: ChatMessage) => void;
  collapseTurnActivity: () => void;
};

export function createStreamHandler(deps: Deps) {
  const {
    healthInfo,
    messages,
    tools,
    busy,
    error,
    pendingQuestion,
    stepIdAlias,
    upsertMessage,
    appendChunk,
    appendThinking,
    attachTool,
    maybeSpeak,
    collapseTurnActivity,
  } = deps;

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
      case "message": {
        // 群归属随事件透传进会话池（合并流按 msg.group 过滤，丢了标群视图就不显示）
        const groupFields =
          e.type === "message" && e.group
            ? {
                group: true,
                groupId: e.groupId,
                ...(e.groupName !== undefined ? { groupName: e.groupName } : {}),
              }
            : {};
        if (e.kind === "user") {
          // 去重：本地 local- 回显与服务端回传同一条时原地替换；纯图片消息
          // 本地空文、服务端「（图片）」占位——按回声判定匹配（见 chat/echo.ts）。
          const localIdx = messages.value.findIndex(
            (m) =>
              m.kind === "user" &&
              m.id.startsWith("local-") &&
              sameUserEcho(m, e) &&
              (m.images?.length ?? 0) === (e.images?.length ?? 0) &&
              Date.now() - m.time < 3000,
          );
          if (localIdx >= 0) {
            messages.value[localIdx] = {
              ...messages.value[localIdx],
              id: e.messageId,
              ...groupFields,
              ...(e.images !== undefined && e.images.length > 0 ? { images: e.images } : {}),
            };
        } else {
          upsertMessage({
            id: e.messageId,
            kind: "user",
            content: e.content,
            origin: e.origin ?? "user",
            // SSE 事件携带的来源实例 id（origin=peer）：群视图名字标签、
            // 私聊「来自 X」徽标都靠它——丢了实时消息就只剩匿名头像。
            ...(e.from !== undefined && e.from !== "" ? { from: e.from } : {}),
            time: e.time,
            ...groupFields,
            ...(e.images !== undefined && e.images.length > 0 ? { images: e.images } : {}),
          });
        }
        } else if (e.kind === "system") {
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
              ...groupFields,
              ...(existingThinking !== undefined && existingThinking !== ""
                ? { thinking: existingThinking, thinkingStreaming: false }
                : {}),
              ...(existingTools !== undefined && existingTools.length > 0
                ? { tools: existingTools }
                : {}),
            };
            stepIdAlias.set(e.turnMessageId, e.messageId);
          } else if (e.content !== "") {
            upsertMessage({ id: e.messageId, kind: "assistant" as const, content: e.content, origin: e.origin, time: e.time, ...groupFields });
          }
          maybeSpeak(messages.value[messages.value.length - 1]);
        } else {
          const existing = messages.value.find((m) => m.id === e.messageId);
          const thinking = existing?.thinking;
          const toolsOf = existing?.tools;
          const hasMeta =
            (thinking !== undefined && thinking !== "") ||
            (toolsOf !== undefined && toolsOf.length > 0);
          if (e.content === "" && !hasMeta) break;
          const msg = {
            id: e.messageId,
            kind: "assistant" as const,
            content: e.content,
            origin: e.origin,
            time: e.time,
            ...groupFields,
            ...(thinking !== undefined && thinking !== ""
              ? { thinking, thinkingStreaming: false }
              : {}),
            ...(toolsOf !== undefined && toolsOf.length > 0 ? { tools: toolsOf } : {}),
          };
          upsertMessage(msg);
          maybeSpeak(msg);
        }
        break;
      }
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
        if (e.status === "call") {
          tools.value.push({ ...tool });
        } else {
          // result 合并进对应 call，不再另推一条（避免「调用+结果」叠成两行）
          const last = [...tools.value].reverse().find((t) => t.name === e.name && t.status === "call");
          if (last) {
            last.status = "result";
            if (tool.summary !== undefined) last.summary = tool.summary;
            if (tool.isError !== undefined) last.isError = tool.isError;
            if (tool.callId !== undefined) last.callId = tool.callId;
          } else {
            tools.value.push({ ...tool });
          }
        }
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
          collapseTurnActivity();
          // agent 可能改写了 $COS_HOME/assistant-avatar.* —— 轮末重读磁盘
          void import("../useAssistantAvatar").then((m) => {
            void m.useAssistantAvatar().loadAvatar(true);
          });
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

  return { handleStreamEvent };
}
