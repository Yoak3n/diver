<script setup lang="ts">
import type { ChatMessage } from "../types";

defineProps<{
  msg: ChatMessage;
  ttsVoice: string;
  tauri: boolean;
}>();

defineEmits<{ speak: [msg: ChatMessage] }>();

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
</script>

<template>
  <div class="msg-row" :class="msg.kind">
    <div v-if="msg.kind === 'assistant'" class="avatar small">✦</div>
    <div class="bubble-wrap">
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
    </div>
  </div>
</template>

<style scoped>
.msg-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
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
.bubble-wrap {
  max-width: 76%;
  display: flex;
  flex-direction: column;
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
