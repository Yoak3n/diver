<script setup lang="ts">
import { ref } from "vue";
import type { UserQuestion, UserQuestionAnswerItem } from "../types";

const props = defineProps<{
  requestId: string;
  questions: UserQuestion[];
}>();

const emit = defineEmits<{ answer: [answers: UserQuestionAnswerItem[]] }>();

/** 每个问题的选择状态。 */
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
  // 至少一个问题有答案即可提交；未答问题以 { id, selected: [] } 跳过
  // （dsh user-questions 协议支持 skipped item）
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
    <div class="q-head">小潜想问你</div>
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
  width: min(92%, 560px);
  background: rgba(35, 36, 58, 0.96);
  border: 1px solid rgba(255, 176, 124, 0.35);
  border-radius: 16px;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.45);
}
.q-head {
  font-size: 12px;
  color: #ffb07c;
  letter-spacing: 1px;
}
.q-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.q-header {
  font-size: 12px;
  color: #9a96ad;
}
.q-text {
  font-size: 14px;
  color: #eceaf5;
  line-height: 1.6;
}
.q-detail {
  font-size: 12px;
  color: #9a96ad;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 10px;
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
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 8px 12px;
  color: #d9d6e6;
  cursor: pointer;
  font-family: inherit;
}
.opt-btn:hover {
  background: rgba(255, 255, 255, 0.1);
}
.opt-btn.picked {
  background: rgba(255, 176, 124, 0.16);
  border-color: rgba(255, 176, 124, 0.55);
  color: #ffe3c4;
}
.opt-label {
  font-size: 13px;
}
.opt-desc {
  font-size: 11px;
  color: #9a96ad;
}
.q-custom input {
  width: 100%;
  box-sizing: border-box;
  background: #141420;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  color: #e8e6f0;
  font-size: 13px;
  padding: 8px 12px;
  outline: none;
  font-family: inherit;
}
.q-custom input:focus {
  border-color: rgba(255, 176, 124, 0.5);
}
.q-selected {
  font-size: 11px;
  color: #8d89a1;
}
.q-actions {
  display: flex;
  justify-content: flex-end;
}
.btn.primary {
  background: linear-gradient(135deg, #ff9d6c, #c06ab3);
  border: none;
  font-weight: 600;
  color: #fff;
  border-radius: 10px;
  padding: 8px 18px;
  font-size: 13px;
  cursor: pointer;
  font-family: inherit;
}
.btn.primary:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
