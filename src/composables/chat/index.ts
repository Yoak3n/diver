// useChat 共享单例：聊天状态/连接跨路由存活（设置页切换时不丢 SSE 与消息）。
//
// 首次 useChat() / getChat() 创建；连接生命周期挂在引用方 onMounted/onBeforeUnmount，
// 由 keep-alive 保证从设置页返回时不会被 dispose。

import { onBeforeUnmount, onMounted } from "vue";
import { createChatState } from "./state";
import { createChatTransport } from "./transport";

type ChatState = ReturnType<typeof createChatState>;
type ChatTransport = ReturnType<typeof createChatTransport>;
export type SharedChat = ChatState & ChatTransport;

let shared: SharedChat | null = null;
let mountCount = 0;
let timer: number | null = null;

function ensureChat(): SharedChat {
  if (shared === null) {
    const state = createChatState();
    const transport = createChatTransport(state);
    shared = { ...state, ...transport };
  }
  return shared;
}

/** 已创建则返回共享实例，不创建（设置页等非挂载场景用）。 */
export function getChat(): SharedChat | null {
  return shared;
}

export function useChat(): SharedChat {
  const chat = ensureChat();

  onMounted(() => {
    mountCount += 1;
    if (mountCount === 1) {
      void chat.connect();
      timer = window.setInterval(() => {
        void chat.refreshHealth();
      }, 8000);
    }
  });

  onBeforeUnmount(() => {
    mountCount = Math.max(0, mountCount - 1);
    // keep-alive 切走不触发 unmount；仅真实卸载（窗口关闭/根路由替换）才 dispose。
    if (mountCount === 0) {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
      chat.dispose();
    }
  });

  return chat;
}
