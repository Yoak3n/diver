<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { renderMarkdownHtml } from "../../markdown";
import { isImagePlaceholder } from "../../composables/chat/echo";
import { isNearBottom } from "../../scroll";
import type { ChatMessage, ComposerAttachment } from "../../types";
import AssistantAvatar from "../../components/AssistantAvatar.vue";

const props = defineProps<{
  messages: ChatMessage[];
  composer: string;
  attachments: ComposerAttachment[];
  busy: boolean;
  isReady: boolean;
  canSend: boolean;
  dragOver: boolean;
  moreMenuOpen: boolean;
  switchingModel: boolean;
  /** 还有更早的历史没加载（打开只取最近几轮，其余懒加载） */
  hasMore?: boolean;
  /** 正在懒加载更早消息 */
  loadingOlder?: boolean;
  /** 本桌宠归属实例：非用户消息按实例取头像（peer 消息优先按发送方 from） */
  instanceId?: string;
}>();

const emit = defineEmits<{
  "update:composer": [v: string];
  send: [];
  attachInput: [e: Event];
  paste: [e: ClipboardEvent];
  dragOver: [e: DragEvent];
  drop: [e: DragEvent];
  leaveDrag: [];
  removeAttachment: [id: string];
  toggleMore: [];
  openModelPicker: [];
  closePanel: [];
  loadOlder: [];
}>();

const attachFileInput = ref<HTMLInputElement | null>(null);
const visibleMessages = computed(() => props.messages);

// ---------- 滚动控制：贴底跟随 / 顶到头懒加载 / 前插锚定 / 回底按钮 ----------
const chatMessagesEl = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);
let olderRequestedAt = 0;

function onScroll() {
  const el = chatMessagesEl.value;
  if (!el) return;
  stickToBottom.value = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight, 40);
  if (
    el.scrollTop <= 32 &&
    props.hasMore &&
    !props.loadingOlder &&
    Date.now() - olderRequestedAt > 1200
  ) {
    olderRequestedAt = Date.now();
    emit("loadOlder");
  }
}

function scrollToBottom() {
  const el = chatMessagesEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

// 面板打开 / 消息变化：贴底跟随（面板无消息时也可能刚装载，双帧复贴防晚到布局）
onMounted(() => {
  nextTick(() => {
    scrollToBottom();
    requestAnimationFrame(scrollToBottom);
  });
});
watch(
  () => props.messages.length,
  (n, old) => {
    if (n === 0 || old === 0) {
      // 首批消息到达：强制贴底（修复打开时停在最顶部）
      nextTick(() => {
        scrollToBottom();
        requestAnimationFrame(scrollToBottom);
      });
      return;
    }
    if (stickToBottom.value) nextTick(scrollToBottom);
  },
);

// 前插锚定：懒加载的更早消息并入后按高度差补偿，视口不跳屏
watch(
  () => props.messages[0]?.id,
  async (_next, prev) => {
    if (prev === undefined) return;
    const el = chatMessagesEl.value;
    if (!el) return;
    const prevHeight = el.scrollHeight;
    await nextTick();
    const grew = el.scrollHeight - prevHeight;
    if (grew > 0) el.scrollTop += grew;
  },
);

function pickAttachImages() {
  attachFileInput.value?.click();
}
</script>

<template>
  <div
    class="chat-flow"
    :class="{ 'drag-over': dragOver }"
    @pointerdown.stop
    @dragenter.prevent="emit('dragOver', $event)"
    @dragover.prevent="emit('dragOver', $event)"
    @dragleave.prevent="emit('leaveDrag')"
    @drop="emit('drop', $event)"
  >
    <div ref="chatMessagesEl" class="chat-messages" @scroll.passive="onScroll">
      <div v-if="hasMore || loadingOlder" class="panel-history-older">
        <button
          v-if="hasMore && !loadingOlder"
          class="panel-history-older-btn"
          type="button"
          @pointerdown.stop
          @click="emit('loadOlder')"
        >
          查看更早的消息
        </button>
        <span v-else class="panel-history-older-hint">正在加载更早的消息…</span>
      </div>
      <div
        v-for="(m, i) in visibleMessages"
        :key="m.id + '-' + i"
        class="chat-msg"
        :class="[m.kind, { streaming: m.streaming }]"
      >
        <template v-if="m.kind === 'system'">
          <span class="msg-text system-text">{{ m.content }}</span>
        </template>
        <template v-else>
          <span v-if="m.kind === 'user'" class="msg-label">我</span>
          <AssistantAvatar v-else :size="20" variant="label" :instance-id="m.from ?? props.instanceId" />
          <span class="msg-text">
            <span v-if="(m.images?.length ?? 0) > 0" class="msg-images">
              <img
                v-for="(img, ii) in m.images"
                :key="ii"
                class="msg-image"
                :src="`data:${img.mime};base64,${img.data}`"
                :alt="img.name || '图片'"
              />
            </span>
            <span v-if="!isImagePlaceholder(m)" class="md-body" v-html="renderMarkdownHtml(m.content)"></span>
            <span v-if="m.streaming" class="cursor">▍</span>
          </span>
        </template>
      </div>
      <div v-if="!visibleMessages.length" class="chat-empty">说点什么吧…</div>
    </div>
    <Transition name="panel">
      <button
        v-if="!stickToBottom && visibleMessages.length"
        type="button"
        class="panel-jump-bottom"
        title="回到底部"
        aria-label="回到底部"
        @pointerdown.stop
        @click="scrollToBottom"
      >
        <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M7 2.5v8M3.5 7.5 7 11l3.5-3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </Transition>
    <div v-if="attachments.length" class="panel-attach-strip">
      <div v-for="a in attachments" :key="a.id" class="panel-attach-item">
        <img :src="a.previewUrl" :alt="a.name || '图片'" class="panel-attach-thumb" />
        <button
          class="panel-attach-remove"
          type="button"
          title="移除"
          @pointerdown.stop
          @click="emit('removeAttachment', a.id)"
        >
          ×
        </button>
      </div>
    </div>
    <div class="panel-input-row">
      <input
        ref="attachFileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        @change="emit('attachInput', $event)"
      />
      <button
        class="attach-btn"
        type="button"
        title="添加图片"
        @pointerdown.stop
        @click="pickAttachImages"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="8.5" cy="10" r="1.5" />
          <path d="M21 16l-5-5-4 4-2-2-7 7" />
        </svg>
      </button>
      <input
        :value="composer"
        type="text"
        :placeholder="
          isReady
            ? busy
              ? '正在思考…（可插话，回车即插队）'
              : '说点什么吧…（可粘贴图片）'
            : '连接中…'
        "
        :disabled="!isReady"
        @input="emit('update:composer', ($event.target as HTMLInputElement).value)"
        @keydown.enter="emit('send')"
        @paste="emit('paste', $event)"
      />
      <button
        class="send-btn"
        :class="{ busy }"
        :disabled="!canSend"
        :title="busy ? '发送插话（即时生效）' : '发送'"
        @click="emit('send')"
      >
        <svg v-if="!busy" class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 2 11 13" />
          <path d="M22 2 15 22 11 13 2 9 22 2Z" />
        </svg>
        <span v-else class="busy-dots">…</span>
      </button>
      <div class="more-menu-wrap">
        <button class="more-btn" title="更多" @click="emit('toggleMore')">⋯</button>
        <Transition name="panel">
          <div v-if="moreMenuOpen" class="more-menu">
            <button class="more-opt" @click="emit('openModelPicker')">
              切换模型{{ switchingModel ? " …" : "" }}
            </button>
            <button class="more-opt" @click="emit('closePanel')">收起面板</button>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>
