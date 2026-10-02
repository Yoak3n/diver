// 桌宠轻量聊天：入口 composable（只做装配与生命周期；状态 / 事件 / IO 分层见 chat/）。

import { onBeforeUnmount } from "vue";
import { createPetChatState } from "./chat/state";
import { createPetChatIo } from "./chat/io";
import { createTtsBridge } from "../composables/chat/ttsBridge";
import { useSettings } from "../composables/useSettings";
import { ttsSpeakSpecOf } from "../tts/queue";
import type { InstanceTtsProfile } from "../ipc/instances";

export function usePetChat(
  getInstanceId?: () => string | undefined,
  getAutoRead?: () => boolean,
  getTtsProfile?: () => InstanceTtsProfile | null,
) {
  const state = createPetChatState();
  // 自动朗读与主窗私聊同语义：全局 TTS 总开关 AND 实例 autoRead；
  // 群消息由 maybeSpeak 的 group 守卫拒读；音色随实例档案覆盖（null = 跟随全局声线）。
  const { state: settingsState } = useSettings();
  const tts = createTtsBridge();
  tts.setTtsSource(() => ({
    enabled: settingsState.ttsEnabled && (getAutoRead?.() ?? true),
    voice: ttsSpeakSpecOf(getTtsProfile?.() ?? null) ?? settingsState.ttsVoice,
  }));
  const io = createPetChatIo(state, getInstanceId, tts.maybeSpeak);

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
