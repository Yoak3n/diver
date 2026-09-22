<script setup lang="ts">
import { ref } from "vue";
import type { UserQuestion, UserQuestionAnswerItem } from "../types";

const props = defineProps<{
  requestId: string;
  questions: UserQuestion[];
}>();

const emit = defineEmits<{ answer: [answers: UserQuestionAnswerItem[]] }>();

const selections = ref<Record<string, string[]>>({});
const customs = ref<Record<string, string>>({});

function toggleOption(q: UserQuestion, label: string) {
  const cur = selections.value[q.id] ?? [];
  if (q.multiSelect) {
    selections.value[q.id] = cur.includes(label)
      ? cur.filter((l) => l !== label)
      : [...cur, label];
  } else {
    selections.value[q.id] = [label];
  }
}

function selected(q: UserQuestion): string {
  return (selections.value[q.id] ?? []).join(", ");
}

function canSubmit(): boolean {
  return props.questions.some((q) => {
    const sel = selections.value[q.id] ?? [];
    const custom = (customs.value[q.id] ?? "").trim();
    return sel.length > 0 || custom.length > 0;
  });
}

function submit() {
  const answers = props.questions.map((q) => {
    const item: UserQuestionAnswerItem = { id: q.id, selected: selections.value[q.id] ?? [] };
    const custom = (customs.value[q.id] ?? "").trim();
    if (custom) item.custom = custom;
    return item;
  });
  emit("answer", answers);
}
</script>

<template>
  <div class="question-card">
    <div class="q-head">想问你</div>
    <div v-for="q in questions" :key="q.id" class="q-item">
      <div v-if="q.header" class="q-header">{{ q.header }}</div>
      <div class="q-text">{{ q.question }}</div>
      <div v-if="q.detail" class="q-detail">{{ q.detail }}</div>
      <div v-if="q.options?.length" class="q-options">
        <button
          v-for="opt in q.options"
          :key="opt.label"
          class="opt-btn"
          :class="{ picked: (selections[q.id] ?? []).includes(opt.label) }"
          @click="toggleOption(q, opt.label)"
        >
          <span class="opt-label">{{ opt.label }}</span>
          <span v-if="opt.description" class="opt-desc">{{ opt.description }}</span>
        </button>
      </div>
      <div v-if="!q.options?.length || q.multiSelect" class="q-custom">
        <input
          v-model="customs[q.id]"
          type="text"
          :placeholder="q.multiSelect ? '补充说明（可选）' : '输入你的回答…'"
        />
      </div>
      <div v-if="q.options?.length" class="q-selected">已选：{{ selected(q) || "（未选）" }}</div>
    </div>
    <div class="q-actions">
      <button class="btn primary" :disabled="!canSubmit()" @click="submit">回答</button>
    </div>
  </div>
</template>

<style scoped>
.question-card {
  align-self: center;
  width: min(100%, 560px);
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-lg);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.q-head {
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-muted);
  letter-spacing: 0.08em;
}
.q-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.q-header {
  font-size: 12px;
  color: var(--ink-muted);
}
.q-text {
  font-size: 14px;
  color: var(--ink);
  line-height: 1.6;
}
.q-detail {
  font-size: 12px;
  color: var(--ink-muted);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--paper-sunken);
  border: 1px solid var(--rule);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  max-height: 200px;
  overflow-y: auto;
}
.q-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.opt-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  background: transparent;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  padding: 9px 12px;
  color: var(--ink-soft);
  cursor: pointer;
  font-family: inherit;
  transition:
    transform var(--dur-press) var(--ease-out),
    background var(--dur-hover) ease,
    border-color var(--dur-hover) ease,
    color var(--dur-hover) ease;
}
@media (hover: hover) and (pointer: fine) {
  .opt-btn:hover {
    background: var(--paper-hover);
  }
}
.opt-btn:active {
  transform: scale(0.97);
}
.opt-btn.picked {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--paper);
}
.opt-btn.picked .opt-desc {
  color: var(--ink-faint);
}
.opt-label {
  font-size: 13px;
}
.opt-desc {
  font-size: 11px;
  color: var(--ink-muted);
}
.q-selected {
  font-size: 11px;
  color: var(--ink-dim);
}
.q-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
