<script setup lang="ts">
import { computed } from "vue";
import type { ChatMessage, ToolActivity } from "../types";
import ThinkingBlock from "./ThinkingBlock.vue";

const props = defineProps<{
  msg: ChatMessage;
  ttsVoice: string;
  tauri: boolean;
}>();

defineEmits<{ speak: [msg: ChatMessage] }>();

const hasContent = computed(() => (props.msg.content ?? "") !== "");
const hasThinking = computed(() => (props.msg.thinking ?? "") !== "");
const toolList = computed(() => props.msg.tools ?? []);
const hasTools = computed(() => toolList.value.length > 0);
/** 无正文气泡（仅思考 / 工具记录）：不占空气泡，左侧对齐到头像列。 */
const metaOnly = computed(() => !hasContent.value && (hasThinking.value || hasTools.value));
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
        <div v-for="(t, i) in toolList" :key="t.callId ?? i" class="tool-record" :class="[t.status, { error: t.isError }]">
          <span class="tool-icon" aria-hidden="true">⚙</span>
          <span class="tool-name">{{ t.name }}</span>
          <span class="sep">·</span>
          <span class="tool-status">{{ toolLabel(t) }}</span>
          <span v-if="toolPreview(t)" class="sep">·</span>
          <span v-if="toolPreview(t)" class="tool-summary">{{ toolPreview(t) }}</span>
        </div>
      </div>
      <template v-if="showBubble">
        <div class="bubble" :class="{ streaming: msg.streaming }">
          <span v-if="msg.origin === 'presence'" class="origin-tag">主动</span>
          <span v-html="msg.content.replace(/\n/g, '<br/>')"></span>
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
            🔊
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.msg-row {
  display: flex;
  gap: 10px;
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
  color: #8d89a1;
  font-size: 12px;
  padding: 4px 10px;
}
/* 无正文时没有头像，用 44px 对齐到有头像消息的内容起点 */
.msg-row.meta-only .bubble-wrap {
  padding-left: 44px;
}
.bubble-wrap {
  max-width: 76%;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.bubble-wrap.with-thinking,
.bubble-wrap.with-tools {
  max-width: 100%;
  min-width: 0;
}
/* 展开到整行时，子内容统一收回到正文同宽 */
.bubble-wrap.with-thinking > *,
.bubble-wrap.with-tools > * {
  max-width: min(76%, 720px);
}
.msg-row.user .bubble-wrap {
  align-items: flex-end;
}
.bubble {
  padding: 10px 14px;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
  white-space: pre-wrap;
}
.msg-row.assistant .bubble {
  background: #232336;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-top-left-radius: 4px;
  color: #e8e6f0;
}
.msg-row.user .bubble {
  background: linear-gradient(135deg, #4a3f6e, #5b4d8a);
  border-top-right-radius: 4px;
  color: #f4f2fa;
}
.bubble.streaming {
  border-color: rgba(255, 176, 124, 0.4);
}
.cursor {
  color: #ffb07c;
  animation: pulse 0.9s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.origin-tag {
  display: inline-block;
  font-size: 10px;
  color: #ffb07c;
  border: 1px solid rgba(255, 176, 124, 0.4);
  border-radius: 8px;
  padding: 0 6px;
  margin-right: 6px;
  vertical-align: 1px;
}
.tool-records {
  min-width: 0;
  margin: 2px 0 6px;
  font-size: 12px;
  line-height: 1.55;
  color: #8d89a1;
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
  color: #6f6b85;
}
.tool-name {
  flex-shrink: 0;
  font-weight: 500;
  color: #9a96ad;
}
.tool-record .sep {
  flex-shrink: 0;
  color: #5c5870;
}
.tool-status {
  flex-shrink: 0;
  color: #7a768f;
}
.tool-record.call .tool-status {
  color: #ffb07c;
}
.tool-record.error .tool-status {
  color: #d37d7d;
}
.tool-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #7a768f;
  flex: 1;
}
.bubble-foot {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 3px;
  padding: 0 4px;
}
.time {
  font-size: 11px;
  color: #6f6b85;
}
.speak-btn {
  background: none;
  border: none;
  color: #8d89a1;
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.speak-btn:hover {
  color: #ffb07c;
}
.avatar.small {
  width: 34px;
  height: 34px;
  font-size: 15px;
  box-shadow: none;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #ff9d6c, #b06ab3 60%, #6a8cff);
  user-select: none;
  flex-shrink: 0;
}
</style>
