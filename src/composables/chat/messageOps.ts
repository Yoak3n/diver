// 聊天消息列表操作（upsert / 流式追加 / 工具挂载）。

import { nextTick, type Ref } from "vue";
import type { ChatMessage, ToolActivity } from "../../types";
import { isNearBottom } from "../../scroll";

export function createMessageOps(
  messages: Ref<ChatMessage[]>,
  stepIdAlias: Map<string, string>,
) {
  /** force：新消息插入等主动场景；默认仅贴近底部时跟随，避免打断上翻阅读。 */
  function scrollToBottom(force = false) {
    nextTick(() => {
      const el = document.querySelector(".chat-scroll");
      if (!(el instanceof HTMLElement)) return;
      if (!force && !isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)) return;
      el.scrollTop = el.scrollHeight;
    });
  }

  function upsertMessage(msg: Omit<ChatMessage, "streaming"> & { streaming?: boolean }) {
    const idx = messages.value.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      messages.value[idx] = { ...messages.value[idx], ...msg };
    } else {
      messages.value.push({ streaming: false, ...msg });
    }
    // 新消息进时间线：强制贴底，避免发送后看不见自己那条
    scrollToBottom(true);
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
      // 优先合并到待完成的 call；若结果重放/重挂则就地更新已有 result，避免叠行
      let hit = -1;
      if (tool.callId !== undefined) {
        hit = list.findIndex((t) => t.callId === tool.callId && t.status === "call");
        if (hit < 0) {
          hit = list.findIndex((t) => t.callId === tool.callId && t.status === "result");
        }
      } else {
        const i = [...list].reverse().findIndex((t) => t.name === tool.name && t.status === "call");
        hit = i >= 0 ? list.length - 1 - i : -1;
      }
      if (hit >= 0) {
        list[hit] = {
          ...list[hit],
          status: "result",
          ...(tool.summary !== undefined ? { summary: tool.summary } : {}),
          ...(tool.isError !== undefined ? { isError: tool.isError } : {}),
          ...(tool.callId !== undefined ? { callId: tool.callId } : {}),
        };
      } else {
        list.push({ ...tool });
      }
    } else {
      // 同 callId 的 call 不重复入列（事件重放）
      if (tool.callId !== undefined && list.some((t) => t.callId === tool.callId)) {
        messages.value[idx] = { ...m, tools: list };
        scrollToBottom();
        return;
      }
      list.push({ ...tool });
    }
    messages.value[idx] = { ...m, tools: list };
    scrollToBottom();
  }

  return { upsertMessage, appendChunk, appendThinking, attachTool, scrollToBottom };
}
