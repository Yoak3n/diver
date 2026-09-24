<script setup lang="ts">
// 助手头像标记：自定义图或默认 ✦。
import { onMounted } from "vue";
import { useAssistantAvatar } from "../composables/useAssistantAvatar";

const props = withDefaults(
  defineProps<{
    /** 圆角方边长（px） */
    size?: number;
    /** 额外 class（对齐原 avatar/brand-mark/welcome-mark 样式） */
    variant?: "avatar" | "brand" | "welcome" | "label";
  }>(),
  { size: 26, variant: "avatar" },
);

const { avatarUrl, loadAvatar } = useAssistantAvatar();
onMounted(() => {
  void loadAvatar();
});
</script>

<template>
  <span
    class="assistant-avatar"
    :class="[props.variant]"
    :style="{ width: `${props.size}px`, height: `${props.size}px` }"
    aria-hidden="true"
  >
    <img v-if="avatarUrl" class="img" :src="avatarUrl" alt="" />
    <span v-else class="fallback">✦</span>
  </span>
</template>

<style scoped>
.assistant-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  user-select: none;
  background: var(--ink);
  color: var(--paper);
}
.assistant-avatar.brand {
  border-radius: 4px;
}
.assistant-avatar.avatar {
  border-radius: 5px;
  margin-top: 2px;
}
.assistant-avatar.welcome {
  border-radius: 8px;
}
.assistant-avatar.label {
  border-radius: 4px;
}
.fallback {
  font-weight: 700;
  line-height: 1;
}
.assistant-avatar.brand .fallback {
  font-size: 10px;
}
.assistant-avatar.avatar .fallback {
  font-size: 12px;
}
.assistant-avatar.welcome .fallback {
  font-size: 18px;
}
.assistant-avatar.label .fallback {
  font-size: 11px;
}
.img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: inherit;
}
</style>
