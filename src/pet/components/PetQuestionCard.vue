<script setup lang="ts">
import type { UserQuestion } from "../../types";

defineProps<{
  questions: UserQuestion[];
  selections: Record<string, string[]>;
  customs: Record<string, string>;
}>();

const emit = defineEmits<{
  toggle: [qId: string, label: string, multiSelect?: boolean];
  "update:custom": [qId: string, value: string];
  answer: [];
}>();
</script>

<template>
  <div class="question-card" @pointerdown.stop>
    <div v-for="q in questions" :key="q.id" class="q-item">
      <div class="q-text">{{ q.question }}</div>
      <div v-if="q.options?.length" class="q-options">
        <button
          v-for="opt in q.options"
          :key="opt.label"
          class="q-opt"
          :class="{ picked: (selections[q.id] ?? []).includes(opt.label) }"
          @click="emit('toggle', q.id, opt.label, q.multiSelect)"
        >
          {{ opt.label }}
        </button>
      </div>
      <input
        v-if="!q.options?.length || q.multiSelect"
        :value="customs[q.id]"
        type="text"
        :placeholder="q.multiSelect ? '补充（可选）' : '输入回答…'"
        class="q-input"
        @input="emit('update:custom', q.id, ($event.target as HTMLInputElement).value)"
      />
    </div>
    <div class="q-actions">
      <button class="send-btn" @click="emit('answer')">回答</button>
    </div>
  </div>
</template>
