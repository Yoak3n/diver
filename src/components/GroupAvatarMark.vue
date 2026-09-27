<script setup lang="ts">
// 群头像标记：自定义图或首字渐变块回退（与原侧栏占位风格一致）。
// 群头像变更经版本号驱动已挂载实例重拉，无需重新挂载。
import { computed, onMounted, ref, watch } from "vue";
import { getGroupAvatarUrl, groupAvatarsVersion } from "../composables/useGroupAvatars";

const props = withDefaults(
  defineProps<{
    groupId: string;
    /** 群名（回退取首字） */
    name: string;
    /** 方边长（px） */
    size?: number;
    /** 圆角（px） */
    radius?: number;
  }>(),
  { size: 38, radius: 8 },
);

const url = ref<string | null>(null);

async function reload(): Promise<void> {
  url.value = await getGroupAvatarUrl(props.groupId);
}

onMounted(() => {
  void reload();
});
watch(
  () => [groupAvatarsVersion.value, props.groupId] as const,
  () => {
    void reload();
  },
);

const initial = computed(() => (props.name || "群").slice(0, 1));
</script>

<template>
  <span
    class="group-avatar"
    :style="{
      width: `${props.size}px`,
      height: `${props.size}px`,
      borderRadius: `${props.radius}px`,
      fontSize: `${Math.round(props.size * 0.42)}px`,
    }"
    aria-hidden="true"
  >
    <img v-if="url" class="img" :src="url" alt="" />
    <span v-else>{{ initial }}</span>
  </span>
</template>

<style scoped>
.group-avatar {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  user-select: none;
  color: #fff;
  background: linear-gradient(135deg, #6ea8fe, #8f6fe8);
}
.img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: inherit;
}
</style>
