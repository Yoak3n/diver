// 桌宠轻量聊天：状态池（refs + 计算 + 消息/附件操作；无 IO、无传输）。

import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { ChatMessage, ComposerAttachment, UserQuestion } from "../../types";
import { hasVisibleMessageBody } from "../../markdown";

/** 活跃会话池硬上限（长时间挂机不无限增长）。 */
export const MAX_MESSAGES = 60;

export interface PetChatState {
  messages: Ref<ChatMessage[]>;
  busy: Ref<boolean>;
  connected: Ref<boolean>;
  error: Ref<string | null>;
  composer: Ref<string>;
  /** 输入框待发送图片（拖入 / 粘贴截图 / 选文件）。 */
  attachments: Ref<ComposerAttachment[]>;
  /** TTS 总开关（与主窗口共享的 diver 设置，未开启时桌宠不朗读）。 */
  ttsEnabled: Ref<boolean>;
  ttsVoice: Ref<string>;
  /** 模型通过 ask_user_question 提出的问题（待用户回答）。 */
  pendingQuestion: Ref<{ requestId: string; questions: UserQuestion[] } | null>;
  /** 历史分页：打开只取最近几轮，更早消息按锚点懒加载。 */
  historyHasMore: Ref<boolean>;
  loadingOlder: Ref<boolean>;
  /** 连接就绪（占位符 / 按钮可用性）。 */
  isReady: ComputedRef<boolean>;
  /** 本次草稿可发送。 */
  canSend: ComputedRef<boolean>;
  push(msg: ChatMessage): void;
  addAttachments(items: ComposerAttachment[]): void;
  removeAttachment(id: string): void;
  clearAttachments(): void;
}

export function createPetChatState(): PetChatState {
  const messages = ref<ChatMessage[]>([]);
  const busy = ref(false);
  const connected = ref(false);
  const error = ref<string | null>(null);
  const composer = ref("");
  const attachments = ref<ComposerAttachment[]>([]);
  const ttsEnabled = ref(false);
  const ttsVoice = ref("");
  const pendingQuestion = ref<{ requestId: string; questions: UserQuestion[] } | null>(null);
  const historyHasMore = ref(false);
  const loadingOlder = ref(false);

  // 就绪 = 已连接即可输入/发送；busy 不锁输入——输出中发送走 steer 插话（与主窗口同语义）。
  const isReady = computed(() => connected.value);
  const canSend = computed(
    () => isReady.value && (composer.value.trim() !== "" || attachments.value.length > 0),
  );

  function addAttachments(items: ComposerAttachment[]) {
    for (const item of items) {
      if (attachments.value.length >= 8) break;
      attachments.value.push(item);
    }
  }

  function removeAttachment(id: string) {
    const idx = attachments.value.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const [gone] = attachments.value.splice(idx, 1);
    try {
      URL.revokeObjectURL(gone.previewUrl);
    } catch {
      /* 忽略 */
    }
  }

  function clearAttachments() {
    for (const a of attachments.value) {
      try {
        URL.revokeObjectURL(a.previewUrl);
      } catch {
        /* 忽略 */
      }
    }
    attachments.value = [];
  }

  function push(msg: ChatMessage) {
    // 无正文无图的步骤（纯工具/思考）不进桌宠消息流，避免空白气泡
    if (!hasVisibleMessageBody(msg)) return;
    messages.value.push(msg);
    if (messages.value.length > MAX_MESSAGES) {
      messages.value = messages.value.slice(-MAX_MESSAGES);
    }
  }

  return {
    messages,
    busy,
    connected,
    error,
    composer,
    attachments,
    ttsEnabled,
    ttsVoice,
    pendingQuestion,
    historyHasMore,
    loadingOlder,
    isReady,
    canSend,
    push,
    addAttachments,
    removeAttachment,
    clearAttachments,
  };
}
