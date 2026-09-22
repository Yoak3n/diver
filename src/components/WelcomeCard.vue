<script setup lang="ts">
defineProps<{
  modelConfigured: boolean;
}>();

defineEmits<{
  "open-settings": [];
  suggestion: [text: string];
}>();
</script>

<template>
  <div class="welcome">
    <div class="welcome-mark">✦</div>
    <h2>你好呀，想聊点什么？</h2>
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
      <button class="chip" @click="$emit('suggestion', '今天有什么值得开心的事吗？')">
        今天有什么开心的事？
      </button>
      <button class="chip" @click="$emit('suggestion', '帮我规划一下今天的安排')">
        帮我规划今天的安排
      </button>
      <button class="chip" @click="$emit('suggestion', '推荐一部适合现在看的电影')">
        推荐一部电影
      </button>
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
  gap: 14px;
  padding: 40px 0;
}
.welcome-mark {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 600;
  color: var(--paper);
  background: var(--ink);
  user-select: none;
}
.welcome h2 {
  margin: 4px 0 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.025em;
  line-height: 1.2;
}
.welcome-sub {
  color: var(--ink-muted);
  font-size: 13px;
  line-height: 1.75;
  margin: 0;
}
.welcome-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 8px;
}
.chip {
  background: transparent;
  border: 1px solid var(--rule-strong);
  color: var(--ink-soft);
  border-radius: var(--radius-pill);
  padding: 7px 14px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition:
    transform var(--dur-press) var(--ease-out),
    background var(--dur-hover) ease,
    color var(--dur-hover) ease,
    border-color var(--dur-hover) ease;
}
@media (hover: hover) and (pointer: fine) {
  .chip:hover {
    background: var(--paper-hover);
    color: var(--ink);
    border-color: var(--rule-strong);
  }
}
.chip:active {
  transform: scale(0.97);
}
</style>
