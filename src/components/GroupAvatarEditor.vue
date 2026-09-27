<script setup lang="ts">
// 群头像编辑（群管理面板内）：预览 + 上传（中心方裁 256×256）+ 恢复默认。
// 变更经 useGroupAvatars 版本号驱动侧栏群行等展示位即时刷新。
import { ref, watch } from "vue";
import {
  getGroupAvatarUrl,
  resetGroupAvatar,
  setGroupAvatarFromFile,
} from "../composables/useGroupAvatars";
import { tauriAvailable } from "../tauri";
import GroupAvatarMark from "./GroupAvatarMark.vue";

const props = defineProps<{
  groupId: string;
  name: string;
  /** 管理动作进行中时禁用（与面板 working 对齐） */
  disabled?: boolean;
}>();

const busy = ref(false);
const msg = ref("");
const hasCustom = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

watch(
  () => props.groupId,
  async () => {
    msg.value = "";
    hasCustom.value = !!(await getGroupAvatarUrl(props.groupId));
  },
  { immediate: true },
);

async function onPick(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value) return;
  if (!tauriAvailable()) {
    msg.value = "仅桌面端可保存群头像";
    return;
  }
  busy.value = true;
  try {
    await setGroupAvatarFromFile(props.groupId, file);
    hasCustom.value = true;
    msg.value = "群头像已保存";
  } catch (e) {
    msg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function onReset() {
  if (busy.value || !tauriAvailable()) return;
  busy.value = true;
  try {
    await resetGroupAvatar(props.groupId);
    hasCustom.value = false;
    msg.value = "已恢复默认群头像";
  } catch (e) {
    msg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="gae">
    <GroupAvatarMark :group-id="groupId" :name="name" :size="36" :radius="8" />
    <button
      class="gae-btn"
      type="button"
      :disabled="disabled || busy || !tauriAvailable()"
      @click="fileInput?.click()"
    >
      {{ busy ? "处理中…" : "上传图片" }}
    </button>
    <button
      v-if="hasCustom"
      class="gae-btn"
      type="button"
      :disabled="disabled || busy"
      @click="onReset"
    >
      恢复默认
    </button>
    <input
      ref="fileInput"
      class="gae-file"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      @change="onPick"
    />
  </div>
  <p v-if="msg" class="gae-msg">{{ msg }}</p>
</template>

<style scoped>
.gae {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gae-btn {
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: none;
  border-radius: 6px;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
  color: var(--fg, #444);
}
.gae-btn:hover:not(:disabled) {
  border-color: var(--accent, #4080ff);
  color: var(--accent, #4080ff);
}
.gae-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.gae-file {
  display: none;
}
.gae-msg {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--accent, #4080ff);
}
</style>
