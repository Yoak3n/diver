<script setup lang="ts">
// 助手头像标记：自定义图或默认 ✦。带 instanceId 时按该实例解析（群聊按发送实例）。
import { computed, onMounted, ref, watch } from "vue";
import {
  getInstanceAvatar,
  instanceAvatarsVersion,
  useAssistantAvatar,
} from "../composables/useAssistantAvatar";

const props = withDefaults(
  defineProps<{
    /** 圆角方边长（px） */
    size?: number;
    /** 额外 class（对齐原 avatar/brand-mark/welcome-mark/侧栏行样式） */
    variant?: "avatar" | "brand" | "welcome" | "label" | "rail";
    /** 来源实例 id：传入则显示该实例头像；缺省 = 当前（active）实例 */
    instanceId?: string;
  }>(),
  { size: 26, variant: "avatar" },
);

const { avatarUrl, loadAvatar } = useAssistantAvatar();
const instanceUrl = ref<string | null>(null);

function loadInstanceAvatar(): void {
  const id = props.instanceId;
  if (!id) {
    instanceUrl.value = null;
    return;
  }
  void getInstanceAvatar(id).then((url) => {
    instanceUrl.value = url;
  });
}

onMounted(() => {
  void loadAvatar();
  loadInstanceAvatar();
});
// 头像可在设置页随时更换：变更版本号驱动已挂载气泡重拉（缓存已失效，重取即新图）
watch(instanceAvatarsVersion, loadInstanceAvatar);
// 组件被复用（如跨会话切换撞 key）时 instanceId 会变：先清旧图再取，防张冠李戴
watch(
  () => props.instanceId,
  () => {
    instanceUrl.value = null;
    loadInstanceAvatar();
  },
);
const shown = computed(() => (props.instanceId ? instanceUrl.value : avatarUrl.value));
</script>

<template>
  <span
    class="assistant-avatar"
    :class="[props.variant, { 'has-img': !!shown }]"
    :style="{ width: `${props.size}px`, height: `${props.size}px` }"
    aria-hidden="true"
  >
    <img v-if="shown" class="img" :src="shown" alt="" />
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
/* 有图时换浅色背衬：透明 PNG（如小贝的樱花）不再压在黑底上显脏边 */
.assistant-avatar.has-img {
  background: var(--paper, #fff);
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
.assistant-avatar.rail {
  border-radius: 8px;
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
.assistant-avatar.rail .fallback {
  font-size: 16px;
}
.img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: inherit;
}
</style>
