// SSE StreamEvent → 本地聊天状态。

import type { Ref } from "vue";
import type {
  ChatMessage,
  HealthInfo,
  StreamEvent,
  ToolActivity,
  UserQuestion,
} from "../../types";

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
      case "message":
        if (e.kind === "user") {
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
            ...(thinking !== undefined && thinking !== ""
              ? { thinking, thinkingStreaming: false }
              : {}),
            ...(toolsOf !== undefined && toolsOf.length > 0 ? { tools: toolsOf } : {}),
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
        if (e.status === "call") {
          tools.value.push({ ...tool });
        } else {
          const last = [...tools.value].reverse().find((t) => t.name === e.name && t.status === "call");
          if (last) last.status = "result";
          if (e.summary) {
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
