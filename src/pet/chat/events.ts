// 桌宠轻量聊天：SSE 流事件 → 状态变换（纯逻辑，IO 只经 hooks 回调）。

import type { ChatMessage, StreamEvent } from "../../types";
import { hasVisibleMessageBody } from "../../markdown";
import { sameUserEcho } from "../../composables/chat/echo";
import type { PetChatState } from "./state";

export interface EventHooks {
  /** sidecar 就绪信号到达时补拉历史（幂等，实现见 io.ts）。 */
  loadHistory: () => Promise<void>;
  /** 回复定稿时自动朗读（注入 ttsBridge.maybeSpeak；纯逻辑层不碰 TTS）。 */
  maybeSpeak?: (msg: ChatMessage) => void;
}

/** 流事件处理：状态归本函数，副作用只经 hooks。 */
export function createEventHandler(state: PetChatState, hooks: EventHooks) {
  const { messages, busy, connected, error, pendingQuestion, push } = state;

  return function handleEvent(e: StreamEvent) {
    switch (e.type) {
      case "hello":
        connected.value = true;
        busy.value = e.busy;
        error.value = null;
        // SSE 流建立说明 sidecar HTTP 已就绪：补拉历史（幂等）
        void hooks.loadHistory();
        break;
      case "message":
        // 他方实例来讯（群聊投递 / 实例间私信）不进桌宠私聊面板：
        // kind 虽是 user，但发言者不是本地用户，贴「我」标签是误标。
        if (e.kind === "user" && e.origin === "peer") break;
        if (e.kind === "user") {
          // 去重：send() 已本地 push 一条 local- 前缀消息，服务端回传同一条时
          // 替换本地消息（拿到服务端 id），而不是再 push 一条造成重复。
          // 纯图片消息本地是空文、服务端是「（图片）」占位——按回声判定匹配。
          const localIdx = messages.value.findIndex(
            (m) =>
              m.id.startsWith("local-") &&
              m.kind === "user" &&
              sameUserEcho(m, e) &&
              (m.images?.length ?? 0) === (e.images?.length ?? 0) &&
              // 只匹配 3 秒内发送的本地消息，避免误合并历史同文消息
              Date.now() - m.time < 3000,
          );
          if (localIdx >= 0) {
            messages.value[localIdx] = {
              ...messages.value[localIdx],
              id: e.messageId,
              time: e.time,
              origin: e.origin ?? "user",
              ...(e.images !== undefined && e.images.length > 0 ? { images: e.images } : {}),
            };
          } else {
            // 本地回显已在发送时改名成服务端 id（steer/队列路径）：原地替换，不 push
            const idx = messages.value.findIndex((m) => m.id === e.messageId);
            const next: ChatMessage = {
              id: e.messageId,
              kind: "user",
              content: e.content,
              origin: e.origin ?? "user",
              time: e.time,
              ...(e.images !== undefined && e.images.length > 0 ? { images: e.images } : {}),
            };
            if (idx >= 0) messages.value[idx] = { ...messages.value[idx], ...next };
            else push(next);
          }
        } else if (e.kind === "system") {
          // presence / 桌宠互动痕迹：折叠行（「（互动）」/ 日程原文）
          push({
            id: e.messageId,
            kind: "system",
            content: e.content,
            origin: e.origin ?? "presence",
            time: e.time,
          });
        } else if (e.turnMessageId) {
          const groupFields = e.group
            ? {
                group: true,
                groupId: e.groupId,
                ...(e.groupName !== undefined ? { groupName: e.groupName } : {}),
              }
            : {};
          const idx = messages.value.findIndex((m) => m.id === e.turnMessageId);
          if (idx >= 0) {
            const next = {
              id: e.messageId,
              kind: "assistant" as const,
              content: e.content,
              origin: e.origin,
              time: e.time,
              streaming: false,
              ...groupFields,
            };
            // 定稿后无正文无图：撤掉流式占位，避免留下空气泡
            if (!hasVisibleMessageBody(next)) messages.value.splice(idx, 1);
            else {
              messages.value[idx] = next;
              hooks.maybeSpeak?.(next);
            }
          } else if (e.content !== "") {
            const msg = {
              id: e.messageId,
              kind: "assistant" as const,
              content: e.content,
              origin: e.origin,
              time: e.time,
              ...groupFields,
            };
            push(msg);
            hooks.maybeSpeak?.(msg);
          }
        } else {
          // 无占位消息的最终消息：跳过空内容（纯工具步骤等），避免空气泡
          if (e.content === "") break;
          const msg = {
            id: e.messageId,
            kind: "assistant" as const,
            content: e.content,
            origin: e.origin,
            time: e.time,
          };
          push(msg);
          hooks.maybeSpeak?.(msg);
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
          // 输出被 token 上限截断时明说，避免看起来像模型故意说半句
          if (e.reason === "max-tokens") {
            push({
              id: `local-maxtok-${Date.now()}`,
              kind: "system",
              content: "（这条回复被输出长度上限截断了，可以说「继续」补完）",
              origin: "assistant",
              time: Date.now(),
            });
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
  };
}
