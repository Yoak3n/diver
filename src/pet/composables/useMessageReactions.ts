// 消息流 → 气泡 / 情绪反应（历史消息不触发）。

import { watch, type Ref } from "vue";
import type { ChatMessage } from "../../types";

type Deps = {
  messages: Ref<ChatMessage[]>;
  panelOpen: () => boolean;
  scrollChatToBottom: () => void;
  onUserMessage: (content: string) => void;
  onAssistantStreaming: (content: string) => void;
  onAssistantDone: (content: string) => void;
  reactToText: (content: string) => void;
};

export function useMessageReactions(deps: Deps) {
  watch(
    () => deps.messages.value,
    (list) => {
      if (deps.panelOpen()) void deps.scrollChatToBottom();
      const last = list[list.length - 1];
      if (!last || last.fromHistory) return;
      if (last.kind === "user") {
        if (!deps.panelOpen()) deps.onUserMessage(last.content);
        else deps.reactToText(last.content);
      } else if (last.kind === "assistant") {
        if (last.streaming) {
          deps.onAssistantStreaming(last.content);
          if (last.content.length >= 4) deps.reactToText(last.content);
        } else if (last.content) {
          if (!deps.panelOpen()) deps.onAssistantDone(last.content);
          deps.reactToText(last.content);
        }
      }
    },
    { deep: true },
  );
}
