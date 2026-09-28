// 桌宠轻量聊天：入口 composable（只做装配与生命周期；状态 / 事件 / IO 分层见 chat/）。

import { onBeforeUnmount } from "vue";
import { createPetChatState } from "./chat/state";
import { createPetChatIo } from "./chat/io";

export function usePetChat(getInstanceId?: () => string | undefined) {
  const state = createPetChatState();
  const io = createPetChatIo(state, getInstanceId);

  onBeforeUnmount(() => {
    state.clearAttachments();
    io.dispose();
  });

  return {
    messages: state.messages,
    busy: state.busy,
    connected: state.connected,
    error: state.error,
    composer: state.composer,
    attachments: state.attachments,
    isReady: state.isReady,
    canSend: state.canSend,
    addAttachments: state.addAttachments,
    removeAttachment: state.removeAttachment,
    clearAttachments: state.clearAttachments,
    connect: io.connect,
    send: io.send,
    startAutoRefresh: io.startAutoRefresh,
    ttsEnabled: state.ttsEnabled,
    ttsVoice: state.ttsVoice,
    pendingQuestion: state.pendingQuestion,
    submitQuestionAnswer: io.submitQuestionAnswer,
    historyHasMore: state.historyHasMore,
    loadingOlder: state.loadingOlder,
    loadOlder: io.loadOlder,
  };
}
