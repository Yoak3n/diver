// useChat 会话池：每实例一份（P2-3 私聊），跨路由存活（设置页切换不丢 SSE 与消息）。
//
// 首次 useChat(id) 创建并连接；会话进程级存活，健康轮询随连接常驻。
// getChat(id) 只取不建（设置页等非挂载场景）。

import { createChatState } from "./state";
import { createChatTransport } from "./transport";

type ChatState = ReturnType<typeof createChatState>;
type ChatTransport = ReturnType<typeof createChatTransport>;
export type SharedChat = ChatState & ChatTransport;

const chats = new Map<string, SharedChat>();

/** 取指定实例的会话（缺省 default；不存在则创建并连接）。 */
export function useChat(instanceId = "default"): SharedChat {
  const hit = chats.get(instanceId);
  if (hit) return hit;
  const state = createChatState();
  const transport = createChatTransport(state, instanceId);
  const chat = { ...state, ...transport };
  chats.set(instanceId, chat);
  void chat.connect();
  return chat;
}

/** 已创建则返回共享会话，不创建（设置页等非挂载场景用）。 */
export function getChat(instanceId = "default"): SharedChat | null {
  return chats.get(instanceId) ?? null;
}
