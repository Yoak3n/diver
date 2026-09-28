<script setup lang="ts">
// 输入框：文本 + 图片附件（拖入文件 / 粘贴截图 / 文件选择）+ 语音输入。
// 图片压到最长边 1600px 的 JPEG，避免 base64 撑爆请求。
// 分层：ComposerAttachments.vue 附件条 | ComposerSendButton.vue 发送按钮
// | useComposerStt.ts 语音输入胶水；本文件只做输入壳与文件交互。
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { ComposerAttachment } from "../types";
import ComposerAttachments from "./ComposerAttachments.vue";
import ComposerSendButton from "./ComposerSendButton.vue";
import { useComposerStt } from "../composables/useComposerStt";

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

// ---------- 语音输入（STT 底座，拍板 2026-09-27：引擎后接） ----------
const { sttNotice, sttState, sttSeconds, sttLevel, toggleStt, cancelStt, fmtStt } = useComposerStt(
  (text) => {
    composer.value = composer.value ? `${composer.value} ${text}` : text;
  },
);

watch(composer, () => {
  const el = ta.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
});

onBeforeUnmount(() => {
  if (ta.value) ta.value.style.height = "";
});

/** 本次草稿可发送（文本或至少一张图）。 */
const hasDraft = computed(() => composer.value.trim() !== "" || props.attachments.length > 0);

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
    <div v-if="sttNotice" class="composer-error">{{ sttNotice }}</div>

    <ComposerAttachments :attachments="attachments" @remove-attachment="emit('removeAttachment', $event)" />

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
      <button
        class="icon-btn attach-btn mic-btn"
        :class="{ recording: sttState === 'recording' }"
        type="button"
        title="语音输入（点击开始/结束，Esc 取消）"
        :disabled="!modelConfigured"
        @click="toggleStt"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="6" y="1.5" width="4" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
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
              ? '正在思考…（可直接发送插话，即时生效）'
              : '先在设置里配置 API Key'
        "
        :disabled="!modelConfigured"
        @keydown.enter.exact="onEnter"
        @paste="onPaste"
      ></textarea>
      <span v-if="sttState === 'recording'" class="stt-live" title="点击麦克风结束，Esc 取消">
        <span class="stt-dot" :style="{ transform: `scale(${0.7 + sttLevel * 0.6})` }"></span>
        {{ fmtStt(sttSeconds) }}
        <button class="stt-cancel" type="button" title="取消本次录音" @click="cancelStt">×</button>
      </span>
      <span v-else-if="sttState === 'transcribing'" class="stt-live">转写中…</span>
      <ComposerSendButton :can-send="canSend" :busy="busy" :has-draft="hasDraft" @send="emit('send')" />
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
.mic-btn.recording {
  color: #e5484d;
  border-color: rgba(229, 72, 77, 0.5);
}
.stt-live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-bottom: 4px;
  font-size: 12px;
  color: #e5484d;
  font-variant-numeric: tabular-nums;
}
.stt-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e5484d;
  transition: transform 80ms ease;
}
.stt-cancel {
  border: none;
  background: none;
  color: var(--ink-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.stt-cancel:hover {
  color: var(--ink);
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
</style>
