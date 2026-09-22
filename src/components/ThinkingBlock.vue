<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  text: string;
  streaming?: boolean;
}>();

const open = ref(false);

/** 收起态预览：正文前段截断（dsh 的「思考 · …」形式）。 */
const preview = computed(() => {
  const t = props.text.replace(/\s+/g, " ").trim();
  if (t === "") return "正在思考…";
  return t.length > 140 ? `${t.slice(0, 140)}…` : t;
});

const paragraphs = computed(() =>
  props.text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== ""),
);
</script>

<template>
  <div class="thinking-block" :class="{ open, streaming }">
    <!-- 收起：图标 + 思考 · 首行预览（dsh 形式） -->
    <button v-if="!open" class="row collapsed" type="button" @click="open = true">
      <span class="icon" aria-hidden="true">✳</span>
      <span class="label">思考</span>
      <span class="sep">·</span>
      <span class="preview">{{ preview }}</span>
    </button>

    <!-- 展开：chevron + 思考，正文分段 -->
    <div v-else class="expanded">
      <button class="row header" type="button" @click="open = false">
        <span class="chevron" aria-hidden="true">⌄</span>
        <span class="label">思考</span>
      </button>
      <div class="body">
        <p v-for="(p, i) in paragraphs" :key="i">{{ p }}</p>
        <span v-if="streaming" class="cursor">▍</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.thinking-block {
  max-width: 100%;
  min-width: 0;
  margin: 2px 0 6px;
  font-size: 13px;
  line-height: 1.65;
  color: #8d89a1;
}
.row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  background: none;
  border: none;
  padding: 2px 0;
  margin: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.row:hover .label {
  color: #b0acc2;
}
.icon {
  flex-shrink: 0;
  font-size: 12px;
  color: #6f6b85;
  transform: translateY(1px);
}
.chevron {
  flex-shrink: 0;
  font-size: 12px;
  color: #6f6b85;
  width: 12px;
  text-align: center;
}
.label {
  flex-shrink: 0;
  font-weight: 500;
  color: #9a96ad;
}
.sep {
  flex-shrink: 0;
  color: #5c5870;
}
.preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #7a768f;
}
.expanded .body {
  padding: 6px 0 4px 18px;
  border-left: 2px solid rgba(255, 255, 255, 0.06);
  margin-left: 5px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.expanded .body p {
  margin: 0 0 10px;
  color: #8d89a1;
  white-space: pre-wrap;
  word-break: break-word;
}
.expanded .body p:last-of-type {
  margin-bottom: 0;
}
.cursor {
  color: #ffb07c;
  animation: pulse 0.9s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.streaming .label {
  color: #b5a89a;
}
</style>
