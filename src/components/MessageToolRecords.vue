<script setup lang="ts">
import { ref } from "vue";
import type { ToolActivity } from "../types";

const props = defineProps<{ tools: ToolActivity[] }>();

/** 工具行展开态：key = callId ?? name#index */
const openTools = ref<Set<string>>(new Set());

function toolKey(t: ToolActivity, i: number): string {
  return t.callId ?? `${t.name}#${i}`;
}

function toggleTool(key: string) {
  const next = new Set(openTools.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  openTools.value = next;
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

function toolDetail(t: ToolActivity): string {
  return (t.summary ?? "").trim();
}
</script>

<template>
  <div class="tool-records">
    <div
      v-for="(t, i) in props.tools"
      :key="toolKey(t, i)"
      class="tool-record"
      :class="[t.status, { error: t.isError, open: openTools.has(toolKey(t, i)) }]"
    >
      <button
        class="tool-row"
        type="button"
        :title="toolDetail(t) ? '点击展开/收起结果' : undefined"
        @click="toggleTool(toolKey(t, i))"
      >
        <span class="tool-icon" aria-hidden="true">⚙</span>
        <span class="tool-name">{{ t.name }}</span>
        <span class="sep">·</span>
        <span class="tool-status">{{ toolLabel(t) }}</span>
        <span v-if="toolPreview(t)" class="sep">·</span>
        <span v-if="toolPreview(t)" class="tool-summary">{{ toolPreview(t) }}</span>
        <span v-if="toolDetail(t)" class="tool-chevron" :class="{ open: openTools.has(toolKey(t, i)) }">›</span>
      </button>
      <div v-if="openTools.has(toolKey(t, i)) && toolDetail(t)" class="tool-detail">
        <pre>{{ toolDetail(t) }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-records {
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-muted);
}
.tool-record {
  min-width: 0;
}
.tool-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  width: 100%;
  padding: 4px 0;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
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
.tool-chevron {
  flex-shrink: 0;
  color: var(--ink-faint);
  transition: transform var(--dur-ui) var(--ease-out);
}
.tool-chevron.open {
  transform: rotate(90deg);
}
.tool-detail {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-sunken);
  max-height: 240px;
  overflow: auto;
}
.tool-detail pre {
  margin: 0;
  font-family: ui-monospace, "Cascadia Code", "Consolas", monospace;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--ink-muted);
}
</style>
