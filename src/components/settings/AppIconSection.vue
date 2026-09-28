<script setup lang="ts">
// 系统设置 · 应用图标区块（上传 / 恢复默认；自包含 useAppIcon）。
import { onMounted, ref } from "vue";
import { tauriAvailable } from "../../tauri";
import { useAppIcon } from "../../composables/useAppIcon";
import AppIconMark from "../AppIconMark.vue";

const { appIconUrl, appIconPath, loadAppIcon, setAppIconFromFile, resetAppIcon } = useAppIcon();
const appIconMsg = ref("");
const appIconBusy = ref(false);
const appIconInput = ref<HTMLInputElement | null>(null);

onMounted(() => {
  void loadAppIcon(true);
});

async function onPickAppIcon(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!tauriAvailable()) {
    appIconMsg.value = "仅桌面端可保存应用图标";
    return;
  }
  appIconBusy.value = true;
  appIconMsg.value = "";
  try {
    await setAppIconFromFile(file);
    appIconMsg.value = "应用图标已保存";
  } catch (e) {
    appIconMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    appIconBusy.value = false;
  }
}

async function onResetAppIcon() {
  if (!tauriAvailable()) return;
  appIconBusy.value = true;
  try {
    await resetAppIcon();
    appIconMsg.value = "已恢复默认应用图标";
  } catch (e) {
    appIconMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    appIconBusy.value = false;
  }
}
</script>

<template>
  <label class="group-title">应用图标</label>
  <div class="avatar-row">
    <AppIconMark :size="48" :radius="8" />
    <div class="avatar-actions">
      <button
        class="btn small"
        type="button"
        :disabled="!tauriAvailable() || appIconBusy"
        @click="appIconInput?.click()"
      >
        {{ appIconBusy ? "处理中…" : "上传图片" }}
      </button>
      <button
        class="btn small"
        type="button"
        :disabled="!tauriAvailable() || appIconBusy || !appIconUrl"
        @click="onResetAppIcon"
      >
        恢复默认
      </button>
    </div>
  </div>
  <input
    ref="appIconInput"
    class="hidden-input"
    type="file"
    accept="image/png,image/jpeg,image/webp,image/gif"
    @change="onPickAppIcon"
  />
  <p v-if="appIconMsg" class="hint">{{ appIconMsg }}</p>
  <p class="hint">
    应用级品牌位（窗口标题栏等），与实例无关；各实例头像在「实例」页单独设置。
    文件路径：<code>{{ appIconPath || "应用配置目录/app-icon.png" }}</code>
  </p>
</template>

<style scoped>
.group-title {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-dim);
  letter-spacing: 0.06em;
  margin-top: 4px;
}
.avatar-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 8px;
}
.avatar-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.hidden-input {
  display: none;
}
.btn.small {
  margin-left: auto;
}
.hint {
  font-size: 11px;
  color: var(--ink-dim);
  margin: 0;
  line-height: 1.7;
}
</style>
