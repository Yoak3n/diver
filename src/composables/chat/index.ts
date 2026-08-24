// useChat 组合入口（chat/ 子模块）。
// 状态与事件映射在 chat/state，HTTP/SSE 传输在 chat/transport，这里只负责装配和生命周期。

import { onBeforeUnmount, onMounted } from "vue";
import { createChatState } from "./state";
import { createChatTransport } from "./transport";

export function useChat() {
  const state = createChatState();
  const transport = createChatTransport(state);

  onMounted(() => {
    void transport.connect();
    const timer = window.setInterval(() => {
      void transport.refreshHealth();
    }, 8000);
    onBeforeUnmount(() => {
      window.clearInterval(timer);
      transport.dispose();
    });
  });

  return {
    ...state,
    ...transport,
  };
}
