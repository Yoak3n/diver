<script setup lang="ts">
// 实例卡片头像：按实例读取 / 点击更换 / 恢复默认。
// 数据在各实例 $COS_HOME/assistant-avatar.<ext>；变更经 avatar://changed 通知各窗口。
import { onMounted, ref } from "vue";
import { tauriAvailable } from "../../../tauri";
import {
  getInstanceAvatar,
  resetAvatar,
  setAvatarFromFile,
} from "../../../composables/useAssistantAvatar";

const props = defineProps<{
  instanceId: string;
  /** 展示名（未命名回退首字符占位） */
  name: string | null;
}>();

const url = ref<string | null>(null);
const busy = ref(false);
const msg = ref("");

onMounted(async () => {
  url.value = await getInstanceAvatar(props.instanceId);
});

async function onPick(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value) return;
  if (!tauriAvailable()) {
    msg.value = "仅桌面端可保存自定义头像";
    return;
  }
  busy.value = true;
  try {
    url.value = await setAvatarFromFile(file, props.instanceId);
    msg.value = "";
  } catch (e) {
    msg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

async function onClear() {
  if (!tauriAvailable() || busy.value) return;
  busy.value = true;
  try {
    url.value = await resetAvatar(props.instanceId);
    msg.value = "";
  } catch (e) {
    msg.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <span class="inst-avatar" :title="msg || (tauriAvailable() ? '点击更换头像' : '')">
    <label class="avatar" :class="{ clickable: tauriAvailable() && !busy }">
      <img v-if="url" :src="url" alt="" />
      <span v-else class="initial">{{ (name || "·").slice(0, 1) }}</span>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        :disabled="!tauriAvailable() || busy"
        @change="onPick"
      />
    </label>
    <button
      v-if="url && tauriAvailable()"
      class="clear-btn"
      type="button"
      title="恢复默认头像"
      :disabled="busy"
      @click="onClear"
    >
      ×
    </button>
  </span>
</template>

<style scoped>
.inst-avatar {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
}
.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--paper-active);
  color: var(--ink-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  overflow: hidden;
  cursor: default;
}
.avatar.clickable {
  cursor: pointer;
}
.avatar.clickable:hover {
  outline: 2px solid var(--rule-strong);
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.initial {
  color: var(--ink-soft);
}
.avatar input[type="file"] {
  display: none;
}
.clear-btn {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--rule-strong);
  background: var(--card, #fff);
  color: var(--ink-muted);
  font-size: 11px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}
.clear-btn:hover {
  color: var(--ink);
}
</style>
