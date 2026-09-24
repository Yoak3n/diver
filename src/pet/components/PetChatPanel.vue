<script setup lang="ts">
import { computed, ref } from "vue";
import { renderMarkdownHtml } from "../../markdown";
import type { ChatMessage, ComposerAttachment } from "../../types";

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
}>();

const attachFileInput = ref<HTMLInputElement | null>(null);
const visibleMessages = computed(() => props.messages);

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
    <div class="chat-messages">
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
          <span v-else class="msg-label">✦</span>
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
            <span class="md-body" v-html="renderMarkdownHtml(m.content)"></span>
            <span v-if="m.streaming" class="cursor">▍</span>
          </span>
        </template>
      </div>
      <div v-if="!visibleMessages.length" class="chat-empty">说点什么吧…</div>
    </div>
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
        :placeholder="isReady ? '说点什么吧…（可粘贴图片）' : busy ? '正在思考…' : '连接中…'"
        :disabled="!isReady"
        @input="emit('update:composer', ($event.target as HTMLInputElement).value)"
        @keydown.enter="emit('send')"
        @paste="emit('paste', $event)"
      />
      <button
        class="send-btn"
        :class="{ busy }"
        :disabled="!canSend"
        :title="busy ? '正在思考…' : '发送'"
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
