<script setup lang="ts">
defineProps<{
  personaName: string;
  statusText: string;
  modelLabel: string;
  dotClass: string;
}>();

defineEmits<{ "open-settings": [] }>();
</script>

<template>
  <header class="topbar">
    <div class="identity">
      <div class="avatar">潜</div>
      <div class="meta">
        <div class="name-row">
          <span class="name">{{ personaName }}</span>
          <span class="badge">陪伴中</span>
        </div>
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
.avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #ff9d6c, #b06ab3 60%, #6a8cff);
  box-shadow: 0 2px 12px rgba(255, 157, 108, 0.35);
  user-select: none;
}
.name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.name {
  font-size: 16px;
  font-weight: 600;
}
.badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
  background: rgba(255, 176, 124, 0.15);
  color: #ffb07c;
  border: 1px solid rgba(255, 176, 124, 0.3);
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
