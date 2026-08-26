<script setup lang="ts">
defineProps<{
  statusText: string;
  modelLabel: string;
  dotClass: string;
}>();

defineEmits<{ "open-settings": [] }>();
</script>

<template>
  <header class="topbar">
    <div class="identity">
      <!-- 不显示名字/头像：不预设身份，头像留待用户自定义 -->
      <div class="meta">
        <div class="status-row">
          <span class="dot" :class="dotClass"></span>
          <span class="status">{{ statusText }}</span>
          <span v-if="modelLabel" class="model">{{ modelLabel }}</span>
        </div>
      </div>
    </div>
    <div class="actions">
      <button class="icon-btn" title="设置" @click="$emit('open-settings')">⚙</button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  background: rgba(24, 25, 38, 0.9);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  -webkit-app-region: drag;
}
.identity {
  display: flex;
  align-items: center;
  gap: 12px;
}
.status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #9a96ad;
}
.model {
  color: #6f6b85;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6f6b85;
}
.dot.on {
  background: #59d99a;
  box-shadow: 0 0 6px #59d99a;
}
.dot.busy {
  background: #ffb07c;
  animation: pulse 1.2s infinite;
}
.dot.off {
  background: #d35d5d;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.actions {
  display: flex;
  gap: 8px;
  -webkit-app-region: no-drag;
}
.icon-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #c9c6da;
  border-radius: 8px;
  width: 32px;
  height: 32px;
  cursor: pointer;
  font-size: 15px;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
}
</style>
