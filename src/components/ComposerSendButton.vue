<script setup lang="ts">
// 发送按钮：箭头图标（就绪）/ 省略号（思考中）。
defineProps<{ canSend: boolean; busy: boolean; hasDraft: boolean }>();

const emit = defineEmits<{ send: [] }>();
</script>

<template>
  <button
    class="send-btn"
    :disabled="!canSend || !hasDraft"
    title="发送"
    @click="emit('send')"
  >
    <svg v-if="!busy" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 8h10M8.5 3.5L13 8l-4.5 4.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
    <span v-else class="busy-dots">…</span>
  </button>
</template>

<style scoped>
.send-btn {
  width: 34px;
  height: 34px;
  border: 1px solid var(--ink);
  border-radius: var(--radius);
  background: var(--ink);
  color: var(--paper);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition:
    transform var(--dur-press) var(--ease-out),
    opacity var(--dur-hover) ease;
}
.send-btn:active:not(:disabled) {
  transform: scale(0.97);
}
.send-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.busy-dots {
  font-size: 16px;
  line-height: 1;
}
</style>
