<script setup lang="ts">
// 设置「插件」页 · 运行档案：当前实例的 companion / safe 切换与 native 探测摘要。
import type { NativeStatus } from "../../../api";

defineProps<{
  activeProfile: string;
  profileBusy: boolean;
  native: NativeStatus | null;
  /** 当前作用域实例名（非 Tauri / 单实例为空）。 */
  instanceName?: string;
}>();

const emit = defineEmits<{
  switch: [profile: "companion" | "safe"];
}>();
</script>

<template>
  <label class="group-title">运行档案（Profile）</label>
  <div class="profile-row">
    <span class="profile-name">
      当前：<strong>{{ activeProfile }}</strong>
      <span v-if="instanceName" class="instance-note">· {{ instanceName }}</span>
      <span v-if="activeProfile === 'safe'" class="badge warn">安全模式</span>
    </span>
    <span class="profile-actions">
      <button
        class="btn small"
        :disabled="profileBusy || activeProfile === 'safe'"
        @click="emit('switch', 'safe')"
      >
        进入安全模式
      </button>
      <button
        class="btn small"
        :disabled="profileBusy || activeProfile === 'companion'"
        @click="emit('switch', 'companion')"
      >
        回到 companion
      </button>
    </span>
  </div>
  <p class="hint">
    安全模式只加载 <code>@cos/*</code> 核心 + <code>@diver/backend</code> 传输，
    用于插件导致启动失败时恢复 UI。完整组合使用 <code>companion</code>。
  </p>
  <div v-if="native" class="hint">
    原生 RPC：{{ native.configured ? native.url : "未配置" }} ·
    {{ native.probes.filter((p) => p.ok).length }}/{{ native.probes.length }} 探测通过
  </div>
</template>

<style scoped>
.group-title {
  display: block;
  margin: 14px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}
.hint {
  font-size: 12px;
  color: var(--ink-muted);
  line-height: 1.5;
  margin: 0 0 8px;
}
.profile-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.profile-name {
  font-size: 13px;
  color: var(--ink);
  font-weight: 500;
}
.instance-note {
  font-size: 12px;
  color: var(--ink-dim);
  font-weight: 400;
}
.profile-actions {
  display: flex;
  gap: 6px;
}
.badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--rule-strong);
  color: var(--ink-muted);
}
.badge.warn {
  color: var(--warn);
  border-color: var(--warn);
}
</style>
