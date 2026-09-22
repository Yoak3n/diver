<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  text: string;
  streaming?: boolean;
}>();

const open = ref(false);

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
    <button v-if="!open" class="row collapsed" type="button" @click="open = true">
      <span class="icon" aria-hidden="true">✳</span>
      <span class="label">思考</span>
      <span class="sep">·</span>
      <span class="preview">{{ preview }}</span>
    </button>

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
  font-size: 12px;
  line-height: 1.65;
  color: var(--ink-muted);
}
.row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  background: none;
  border: none;
  padding: 4px 0;
  margin: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
  transition: transform var(--dur-press) var(--ease-out);
}
@media (hover: hover) and (pointer: fine) {
  .row:hover .label {
    color: var(--ink);
  }
}
.row:active {
  transform: scale(0.99);
}
.icon {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-dim);
}
.chevron {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-dim);
  width: 12px;
  text-align: center;
}
.label {
  flex-shrink: 0;
  font-weight: 500;
  color: var(--ink-soft);
}
.sep {
  flex-shrink: 0;
  color: var(--ink-faint);
}
.preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-dim);
}
.expanded .body {
  padding: 6px 0 4px 16px;
  border-left: 1px solid var(--rule);
  margin-left: 5px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.expanded .body p {
  margin: 0 0 10px;
  color: var(--ink-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
.expanded .body p:last-of-type {
  margin-bottom: 0;
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
.streaming .label {
  color: var(--ink-soft);
}
</style>
