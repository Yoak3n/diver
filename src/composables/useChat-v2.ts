// useChat 组合入口（已迁移至 chat/index.ts，本文件保留待删除）。
// 状态与事件映射在 chatState，HTTP/SSE 传输在 chatTransport，这里只负责装配和生命周期。

import { onBeforeUnmount, onMounted } from "vue";
import { createChatState } from "./chatState";
import { createChatTransport } from "./chatTransport";

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
