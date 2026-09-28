<script setup lang="ts">
// 输入框附件预览条（缩略图 + 移除）。
import type { ComposerAttachment } from "../types";

defineProps<{ attachments: ComposerAttachment[] }>();

const emit = defineEmits<{ removeAttachment: [id: string] }>();
</script>

<template>
  <div v-if="attachments.length" class="attach-strip">
    <div v-for="a in attachments" :key="a.id" class="attach-item">
      <img :src="a.previewUrl" :alt="a.name || '图片'" class="attach-thumb" />
      <button
        class="attach-remove"
        type="button"
        title="移除"
        @click="emit('removeAttachment', a.id)"
      >
        ×
      </button>
    </div>
  </div>
</template>

<style scoped>
.attach-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 2px 2px 0;
}
.attach-item {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--rule);
  overflow: hidden;
  background: var(--paper-sunken);
}
.attach-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.attach-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
</style>
