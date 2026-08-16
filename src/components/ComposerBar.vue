<script setup lang="ts">
const composer = defineModel<string>({ default: "" });

defineProps<{
  canSend: boolean;
  busy: boolean;
  modelConfigured: boolean;
  error: string | null;
}>();

defineEmits<{ send: [] }>();
</script>

<template>
  <footer class="composer-bar">
    <div v-if="error" class="composer-error">{{ error }}</div>
    <textarea
      v-model="composer"
      rows="1"
      :placeholder="
        canSend
          ? '和我说点什么吧…（Enter 发送）'
          : busy
            ? '小潜正在思考…'
            : '先在设置里配置 API Key'
      "
      :disabled="!canSend"
      @keydown.enter.exact.prevent="$emit('send')"
    ></textarea>
    <button class="send-btn" :disabled="!canSend || !composer.trim()" @click="$emit('send')">
      <span v-if="busy">…</span>
      <span v-else>发送</span>
    </button>
  </footer>
</template>

<style scoped>
.composer-bar {
  padding: 10px 16px 14px;
  display: flex;
  gap: 10px;
  align-items: flex-end;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(20, 20, 32, 0.8);
  position: relative;
}
.composer-error {
  position: absolute;
  bottom: 74px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(211, 93, 93, 0.15);
  border: 1px solid rgba(211, 93, 93, 0.4);
  color: #e8a3a3;
  border-radius: 8px;
  font-size: 12px;
  padding: 6px 14px;
  white-space: nowrap;
}
.composer-bar textarea {
  flex: 1;
  resize: none;
  background: #1d1e2e;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  color: #e8e6f0;
  font-size: 14px;
  padding: 10px 14px;
  outline: none;
  font-family: inherit;
  max-height: 120px;
  line-height: 1.6;
}
.composer-bar textarea:focus {
  border-color: rgba(255, 176, 124, 0.5);
}
.composer-bar textarea:disabled {
  opacity: 0.5;
}
.send-btn {
  background: linear-gradient(135deg, #ff9d6c, #c06ab3);
  color: #fff;
  border: none;
  border-radius: 12px;
  padding: 10px 22px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
  font-family: inherit;
}
.send-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
