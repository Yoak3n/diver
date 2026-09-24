<script setup lang="ts">
import AssistantAvatar from "../../components/AssistantAvatar.vue";

defineProps<{
  kind: "user" | "assistant";
  text: string;
  streaming: boolean;
  pos: { left: number; top: number } | null;
}>();

const emit = defineEmits<{
  expand: [];
  close: [];
  enter: [];
  leave: [];
}>();
</script>

<template>
  <div
    class="speech-bubble"
    :class="kind"
    :style="pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : undefined"
    title="点击展开消息面板"
    @pointerdown.stop
    @click.stop="emit('expand')"
    @mouseenter="emit('enter')"
    @mouseleave="emit('leave')"
  >
    <div class="bubble-head">
      <span v-if="kind === 'user'" class="bubble-label">我</span>
      <AssistantAvatar v-else :size="18" variant="label" />
      <button class="bubble-close" title="关闭" @pointerdown.stop @click.stop="emit('close')">
        ×
      </button>
    </div>
    <span class="bubble-text">
      {{ text }}
      <span v-if="streaming" class="cursor">▍</span>
    </span>
    <div v-if="!streaming" class="bubble-hint">点击展开 ›</div>
  </div>
</template>
