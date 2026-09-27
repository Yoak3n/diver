<script setup lang="ts">
// 应用图标标记（品牌位）：自定义图或默认 ✦。与实例头像无关。
import { computed, onMounted } from "vue";
import { useAppIcon } from "../composables/useAppIcon";

const props = withDefaults(
  defineProps<{
    /** 方边长（px） */
    size?: number;
    /** 圆角（px） */
    radius?: number;
  }>(),
  { size: 18, radius: 4 },
);

const { appIconUrl, loadAppIcon } = useAppIcon();
onMounted(() => {
  void loadAppIcon();
});
const shown = computed(() => appIconUrl.value);
</script>

<template>
  <span
    class="app-icon-mark"
    :style="{ width: `${props.size}px`, height: `${props.size}px`, borderRadius: `${props.radius}px` }"
    aria-hidden="true"
  >
    <img v-if="shown" class="img" :src="shown" alt="" />
    <span v-else class="fallback">✦</span>
  </span>
</template>

<style scoped>
.app-icon-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  user-select: none;
  background: var(--ink);
  color: var(--paper);
}
.fallback {
  font-weight: 700;
  line-height: 1;
}
.img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: inherit;
}
</style>
