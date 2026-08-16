<script setup lang="ts">
defineProps<{
  personaName: string;
  modelConfigured: boolean;
}>();

defineEmits<{
  "open-settings": [];
  suggestion: [text: string];
}>();
</script>

<template>
  <div class="welcome">
    <div class="welcome-avatar">潜</div>
    <h2>你好呀，我是{{ personaName }}</h2>
    <p v-if="modelConfigured" class="welcome-sub">
      我会一直陪着你。有什么想聊的、想查的、想计划的，都可以告诉我。
    </p>
    <p v-else class="welcome-sub">
      在开始聊天之前，需要先配置模型 API Key —— 点右上角 ⚙ 打开设置。
    </p>
    <div v-if="!modelConfigured" class="welcome-actions">
      <button class="btn primary" @click="$emit('open-settings')">去配置 API Key</button>
    </div>
    <div v-else class="welcome-chips">
      <button class="chip" @click="$emit('suggestion', '今天有什么值得开心的事吗？')">今天有什么开心的事？</button>
      <button class="chip" @click="$emit('suggestion', '帮我规划一下今天的安排')">帮我规划今天的安排</button>
      <button class="chip" @click="$emit('suggestion', '推荐一部适合现在看的电影')">推荐一部电影</button>
    </div>
  </div>
</template>

<style scoped>
.welcome {
  margin: auto;
  text-align: center;
  max-width: 420px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 30px 0;
}
.welcome-avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #ff9d6c, #b06ab3 60%, #6a8cff);
  box-shadow: 0 4px 24px rgba(255, 157, 108, 0.4);
  user-select: none;
}
.welcome h2 {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 600;
}
.welcome-sub {
  color: #9a96ad;
  font-size: 13px;
  line-height: 1.7;
  margin: 0;
}
.welcome-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 10px;
}
.chip {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #d9d6e6;
  border-radius: 16px;
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.chip:hover {
  border-color: rgba(255, 176, 124, 0.5);
  color: #ffb07c;
}
.btn.primary {
  background: linear-gradient(135deg, #ff9d6c, #c06ab3);
  border: none;
  font-weight: 600;
  color: #fff;
  border-radius: 10px;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}
</style>
