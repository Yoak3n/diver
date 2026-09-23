<script setup lang="ts">
import { computed } from "vue";
import type { ChatMessage, ToolActivity } from "../types";
import ThinkingBlock from "./ThinkingBlock.vue";
import { renderMarkdownHtml } from "../markdown";

const props = defineProps<{
  msg: ChatMessage;
  ttsVoice: string;
  tauri: boolean;
}>();

defineEmits<{ speak: [msg: ChatMessage] }>();

const hasContent = computed(() => (props.msg.content ?? "") !== "");
const contentHtml = computed(() => renderMarkdownHtml(props.msg.content ?? ""));
const hasThinking = computed(() => (props.msg.thinking ?? "") !== "");
const toolList = computed(() => props.msg.tools ?? []);
const hasTools = computed(() => toolList.value.length > 0);
const metaOnly = computed(
  () =>
    !hasContent.value &&
    (props.msg.images?.length ?? 0) === 0 &&
    (hasThinking.value || hasTools.value),
);
const showBubble = computed(() => hasContent.value);

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function toolLabel(t: ToolActivity): string {
  if (t.status === "call") return "调用中";
  return t.isError ? "失败" : "完成";
}

function toolPreview(t: ToolActivity): string {
  const s = (t.summary ?? "").replace(/\s+/g, " ").trim();
  if (s === "") return "";
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}
</script>

<template>
  <div class="msg-row" :class="[msg.kind, { 'meta-only': metaOnly }]">
    <div v-if="msg.kind === 'assistant' && !metaOnly" class="avatar small">✦</div>
    <div class="bubble-wrap" :class="{ 'with-thinking': hasThinking, 'with-tools': hasTools }">
      <ThinkingBlock
        v-if="hasThinking"
        :text="msg.thinking!"
        :streaming="msg.thinkingStreaming"
      />
      <div v-if="hasTools" class="tool-records">
        <div
          v-for="(t, i) in toolList"
          :key="t.callId ?? i"
          class="tool-record"
          :class="[t.status, { error: t.isError }]"
        >
          <span class="tool-icon" aria-hidden="true">⚙</span>
          <span class="tool-name">{{ t.name }}</span>
          <span class="sep">·</span>
          <span class="tool-status">{{ toolLabel(t) }}</span>
          <span v-if="toolPreview(t)" class="sep">·</span>
          <span v-if="toolPreview(t)" class="tool-summary">{{ toolPreview(t) }}</span>
        </div>
      </div>
      <template v-if="showBubble || (msg.images?.length ?? 0) > 0">
        <div v-if="(msg.images?.length ?? 0) > 0" class="msg-images">
          <img
            v-for="(img, i) in msg.images"
            :key="i"
            class="msg-image"
            :src="`data:${img.mime};base64,${img.data}`"
            :alt="img.name || '图片'"
          />
        </div>
        <div v-if="showBubble" class="bubble" :class="{ streaming: msg.streaming }">
          <span v-if="msg.origin === 'presence'" class="origin-tag">主动</span>
          <span v-else-if="msg.origin === 'interaction'" class="origin-tag">互动</span>
          <span v-else-if="msg.origin === 'proactive'" class="origin-tag">主动</span>
          <div class="md-body" v-html="contentHtml"></div>
          <span v-if="msg.streaming" class="cursor">▍</span>
        </div>
        <div class="bubble-foot">
          <span class="time">{{ fmtTime(msg.time) }}</span>
          <button
            v-if="msg.kind === 'assistant' && msg.content && !msg.streaming"
            class="speak-btn"
            title="朗读"
            @click="$emit('speak', msg)"
          >
            朗读
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.msg-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  min-width: 0;
  max-width: 100%;
}
.msg-row.user {
  flex-direction: row-reverse;
}
.msg-row.system {
  justify-content: center;
}
.msg-row.system .bubble {
  background: transparent;
  border: none;
  color: var(--ink-dim);
  font-size: 12px;
  padding: 2px 8px;
}
.msg-row.meta-only .bubble-wrap {
  padding-left: 34px;
}
.bubble-wrap {
  max-width: 82%;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.bubble-wrap.with-thinking,
.bubble-wrap.with-tools {
  max-width: 100%;
  min-width: 0;
}
.bubble-wrap.with-thinking > *,
.bubble-wrap.with-tools > * {
  max-width: min(82%, 680px);
}
.msg-row.user .bubble-wrap {
  align-items: flex-end;
}
.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 6px;
}
.msg-row.user .msg-images {
  justify-content: flex-end;
}
.msg-image {
  max-width: min(220px, 48vw);
  max-height: 180px;
  border-radius: var(--radius);
  border: 1px solid var(--rule);
  object-fit: contain;
  background: var(--paper-sunken);
  display: block;
}
/* 纸感：平面填色 + 细线，不用渐变气泡 */
.bubble {
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
}
.msg-row.assistant .bubble {
  background: var(--paper-raised);
  border: 1px solid var(--rule);
  border-radius: var(--radius-lg);
  color: var(--ink);
}
.msg-row.user .bubble {
  background: var(--user-fill);
  color: var(--user-ink);
  border: 1px solid transparent;
}
.bubble.streaming {
  border-color: var(--rule-strong);
}
.cursor {
  color: var(--ink-dim);
  animation: pulse 0.9s ease infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.origin-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 500;
  color: var(--ink-muted);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-pill);
  padding: 0 7px;
  margin-right: 6px;
  vertical-align: 1px;
}
.tool-records {
  min-width: 0;
  margin: 2px 0 6px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-muted);
}
.tool-record {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  padding: 2px 0;
}
.tool-icon {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-dim);
}
.tool-name {
  flex-shrink: 0;
  font-weight: 500;
  color: var(--ink-soft);
}
.tool-record .sep {
  flex-shrink: 0;
  color: var(--ink-faint);
}
.tool-status {
  flex-shrink: 0;
  color: var(--ink-dim);
}
.tool-record.call .tool-status {
  color: var(--warn);
}
.tool-record.error .tool-status {
  color: var(--err);
}
.tool-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-dim);
  flex: 1;
}
.bubble-foot {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 4px;
  padding: 0 2px;
}
.time {
  font-size: 11px;
  color: var(--ink-dim);
}
.speak-btn {
  background: none;
  border: none;
  color: var(--ink-dim);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
  font-family: inherit;
  transition:
    color var(--dur-hover) ease,
    transform var(--dur-press) var(--ease-out);
}
@media (hover: hover) and (pointer: fine) {
  .speak-btn:hover {
    color: var(--ink);
  }
}
.speak-btn:active {
  transform: scale(0.97);
}
/* 纸面印章式头像：墨色方章，无渐变 */
.avatar.small {
  width: 26px;
  height: 26px;
  font-size: 12px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: var(--paper);
  background: var(--ink);
  user-select: none;
  flex-shrink: 0;
  margin-top: 2px;
}
</style>
