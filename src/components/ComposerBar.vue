<script setup lang="ts">
// 输入框：文本 + 图片附件（拖入文件 / 粘贴截图 / 文件选择）。
// 图片压到最长边 1600px 的 JPEG，避免 base64 撑爆请求。
import { onBeforeUnmount, ref, watch } from "vue";
import type { ComposerAttachment } from "../types";

const composer = defineModel<string>({ default: "" });

const props = defineProps<{
  canSend: boolean;
  /** 连接/模型就绪（占位符与加图按钮可用性）。 */
  isReady: boolean;
  busy: boolean;
  modelConfigured: boolean;
  error: string | null;
  attachments: ComposerAttachment[];
}>();

const emit = defineEmits<{
  send: [];
  addFiles: [files: File[]];
  removeAttachment: [id: string];
}>();

const ta = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);

watch(composer, () => {
  const el = ta.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
});

onBeforeUnmount(() => {
  if (ta.value) ta.value.style.height = "";
});

function onEnter(e: KeyboardEvent) {
  if (e.isComposing) return;
  e.preventDefault();
  if (props.canSend) emit("send");
}

function pickImages() {
  fileInput.value?.click();
}

function onFileInput(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length) emit("addFiles", files);
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && file.type.startsWith("image/")) files.push(file);
  }
  if (files.length) {
    e.preventDefault();
    emit("addFiles", files);
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
  if (files.length) {
    e.preventDefault();
    emit("addFiles", files);
  }
}

function onDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes("Files")) {
    e.preventDefault();
    dragOver.value = true;
  }
}
</script>

<template>
  <footer
    class="composer-bar"
    :class="{ 'drag-over': dragOver }"
    @dragenter.prevent="onDragOver"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="dragOver = false"
    @drop="onDrop"
  >
    <div v-if="error" class="composer-error">{{ error }}</div>

    <div v-if="attachments.length" class="attach-strip">
      <div v-for="a in attachments" :key="a.id" class="attach-item">
        <img :src="a.previewUrl" :alt="a.name || '图片'" class="attach-thumb" />
        <button
          class="attach-remove"
          type="button"
          title="移除"
          @click="emit('removeAttachment', a.id)"
        >
          ×
        </button>
      </div>
    </div>

    <div class="composer-shell">
      <button
        class="icon-btn attach-btn"
        type="button"
        title="添加图片"
        :disabled="!isReady && !modelConfigured"
        @click="pickImages"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <circle cx="5.5" cy="6.5" r="1.2" fill="currentColor" />
          <path
            d="M2.5 11.5l3.2-3.2 2.3 2.3 2-2 3.5 3.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        @change="onFileInput"
      />
      <textarea
        ref="ta"
        v-model="composer"
        rows="1"
        :placeholder="
          isReady
            ? '和我说点什么吧…（Enter 发送；可拖入/粘贴图片）'
            : busy
              ? '正在思考…'
              : '先在设置里配置 API Key'
        "
        :disabled="!modelConfigured"
        @keydown.enter.exact="onEnter"
        @paste="onPaste"
      ></textarea>
      <button
        class="send-btn"
        :disabled="!canSend || (!composer.trim() && attachments.length === 0)"
        title="发送"
        @click="emit('send')"
      >
        <svg v-if="!busy" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2.5 8h10M8.5 3.5L13 8l-4.5 4.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span v-else class="busy-dots">…</span>
      </button>
    </div>
  </footer>
</template>

<style scoped>
.composer-bar {
  padding: 10px 28px 22px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  flex-shrink: 0;
  border: 1px dashed transparent;
  border-radius: var(--radius-lg);
  transition: border-color var(--dur-hover) ease, background var(--dur-hover) ease;
}
.composer-bar.drag-over {
  border-color: var(--accent-border);
  background: var(--accent-soft);
}
.composer-bar > * {
  width: 100%;
  max-width: var(--chat-max);
  margin-left: auto;
  margin-right: auto;
}
.composer-error {
  align-self: center;
  width: fit-content;
  max-width: min(92%, 560px);
  background: var(--err-soft);
  border: 1px solid var(--err-border);
  color: var(--err);
  border-radius: var(--radius-sm);
  font-size: 12px;
  padding: 6px 14px;
}
.attach-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 2px 2px 0;
}
.attach-item {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--rule);
  overflow: hidden;
  background: var(--paper-sunken);
}
.attach-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.attach-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.composer-shell {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-lg);
  padding: 8px 8px 8px 10px;
  transition: border-color var(--dur-hover) ease;
}
.composer-shell:focus-within {
  border-color: var(--ink-muted);
}
.attach-btn {
  width: 32px;
  height: 32px;
  margin-bottom: 2px;
  flex-shrink: 0;
}
.composer-shell textarea {
  flex: 1;
  resize: none;
  background: transparent;
  border: none;
  color: var(--ink);
  font-size: 14px;
  padding: 6px 0;
  outline: none;
  font-family: inherit;
  max-height: 120px;
  line-height: 1.6;
}
.composer-shell textarea:disabled {
  opacity: 0.5;
}
.send-btn {
  width: 34px;
  height: 34px;
  border: 1px solid var(--ink);
  border-radius: var(--radius);
  background: var(--ink);
  color: var(--paper);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition:
    transform var(--dur-press) var(--ease-out),
    opacity var(--dur-hover) ease;
}
.send-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.send-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.busy-dots {
  font-size: 16px;
  line-height: 1;
}
</style>
