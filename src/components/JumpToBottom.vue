<script setup lang="ts">
// 聊天区「回到底部」浮动按钮。
defineProps<{ visible: boolean }>();
const emit = defineEmits<{ jump: [] }>();
</script>

<template>
  <Transition name="jump-bottom">
    <button
      v-if="visible"
      type="button"
      class="jump-bottom"
      title="回到底部"
      aria-label="回到底部"
      @click="emit('jump')"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path
          d="M7 2.5v8M3.5 7.5 7 11l3.5-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </Transition>
</template>

<style scoped>
.jump-bottom {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  width: 34px;
  height: 34px;
  border-radius: var(--radius-pill);
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  color: var(--ink-soft);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  z-index: 6;
  transition:
    transform var(--dur-press) var(--ease-out),
    background var(--dur-hover) ease,
    color var(--dur-hover) ease,
    border-color var(--dur-hover) ease;
}
@media (hover: hover) and (pointer: fine) {
  .jump-bottom:hover {
    background: var(--paper-hover);
    color: var(--ink);
  }
}
.jump-bottom:active {
  transform: translateX(-50%) scale(0.96);
}

.jump-bottom-enter-active,
.jump-bottom-leave-active {
  transition:
    opacity var(--dur-ui) var(--ease-out),
    transform var(--dur-ui) var(--ease-out);
}
.jump-bottom-enter-from,
.jump-bottom-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}
</style>
