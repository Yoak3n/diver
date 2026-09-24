<script setup lang="ts">
// 全局快捷键设置页（热插拔：保存即注册/注销，无需重启 sidecar/应用）。
// 组合键经按键捕获生成，词法对齐 tauri-plugin-global-shortcut（global-hotkey parse_hotkey）。
import { onMounted } from "vue";
import {
  SHORTCUT_ACTION_LABELS,
  tauriAvailable,
  type ShortcutAction,
} from "../../tauri";
import { useShortcuts } from "./composables/useShortcuts";
import { useHotkeyCapture } from "./composables/useHotkeyCapture";

const {
  bindings,
  loading,
  busyId,
  error,
  hint,
  newAction,
  newAccelerator,
  adding,
  refresh,
  onToggle,
  onSaveAccelerator,
  onRemove,
  onAdd,
} = useShortcuts();

const { capturingId, capturePreview, startCapture, stopCapture, dispose } = useHotkeyCapture({
  onError: (m) => {
    error.value = m;
  },
  onCaptured: async (target, accel) => {
    if (target === "__new__") {
      newAccelerator.value = accel;
      await onAdd();
      return;
    }
    const binding = bindings.value.find((b) => b.id === target);
    if (binding) await onSaveAccelerator(binding, accel);
  },
});

const actionLabels = SHORTCUT_ACTION_LABELS;
const actionOptions = Object.entries(actionLabels) as [ShortcutAction, string][];

onMounted(refresh);
onMounted(() => {
  window.addEventListener("beforeunload", () => dispose(), { once: true });
});

function isCapturing(id: string) {
  return capturingId.value === id;
}
</script>

<template>
  <p class="hint">
    全局快捷键：点「录制」后按下组合键，保存后<b>立即生效</b>（无需重启）。
    词法对齐 <code>tauri-plugin-global-shortcut</code>：
    修饰键在前、单个主键在后，如 <code>ctrl+shift+m</code>、<code>alt+1</code>、<code>cmdorctrl+f5</code>。
    录制中按 <code>Esc</code> 取消。
  </p>

  <div v-if="loading && !bindings.length" class="hint">加载中…</div>
  <div v-else-if="!tauriAvailable()" class="hint">不在 Tauri 环境，快捷键不可用。</div>

  <div v-else class="binding-list">
    <div v-for="b in bindings" :key="b.id" class="binding-row">
      <div class="binding-info">
        <div class="binding-accel">
          <button
            type="button"
            class="accel-capture"
            :class="{ recording: isCapturing(b.id) }"
            :disabled="busyId === b.id"
            :title="isCapturing(b.id) ? '按 Esc 取消' : '点击录制组合键'"
            @click="isCapturing(b.id) ? stopCapture() : startCapture(b.id)"
          >
            <template v-if="isCapturing(b.id)">
              {{ capturePreview || "" }}按下快捷键…（Esc 取消）
            </template>
            <template v-else>{{ b.accelerator }}</template>
          </button>
          <button
            type="button"
            class="btn tiny"
            :disabled="busyId === b.id || isCapturing(b.id)"
            title="重新录制"
            @click="startCapture(b.id)"
          >
            录制
          </button>
        </div>
        <div class="binding-action">{{ actionLabels[b.action as ShortcutAction] }}</div>
      </div>
      <label class="switch" :title="b.enabled ? '点击注销' : '点击注册'">
        <input
          type="checkbox"
          :checked="b.enabled"
          :disabled="busyId === b.id"
          @change="onToggle(b, ($event.target as HTMLInputElement).checked)"
        />
        <span class="slider"></span>
      </label>
      <button class="btn small" :disabled="busyId === b.id" @click="onRemove(b)">移除</button>
    </div>
  </div>

  <div class="toolbar">
    <select v-model="newAction" class="action-select">
      <option v-for="[value, label] in actionOptions" :key="value" :value="value">
        {{ label }}
      </option>
    </select>
    <button
      type="button"
      class="accel-capture grow"
      :class="{ recording: isCapturing('__new__') }"
      :disabled="adding"
      :title="isCapturing('__new__') ? '按 Esc 取消' : '点击录制组合键'"
      @click="isCapturing('__new__') ? stopCapture() : startCapture('__new__')"
    >
      <template v-if="isCapturing('__new__')">
        {{ capturePreview || "" }}按下快捷键…（Esc 取消）
      </template>
      <template v-else>{{ newAccelerator || "点击录制组合键" }}</template>
    </button>
    <button class="btn small" :disabled="adding || !newAccelerator.trim()" @click="onAdd">
      新增
    </button>
  </div>

  <p v-if="hint" class="ok-msg">{{ hint }}</p>
  <p v-if="error" class="error-msg">{{ error }}</p>
</template>

<style scoped>
.binding-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.binding-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-raised);
}
.binding-info {
  flex: 1;
  min-width: 0;
}
.binding-accel {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
  color: var(--ink);
}
.accel-capture {
  flex: 1;
  min-width: 0;
  text-align: left;
  background: var(--paper-sunken);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-sm);
  color: var(--ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 600;
  padding: 5px 10px;
  cursor: pointer;
  outline: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (hover: hover) and (pointer: fine) {
  .accel-capture:hover:not(:disabled) {
    border-color: var(--ink-dim);
  }
}
.accel-capture.recording {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.accel-capture:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.accel-capture.grow {
  flex: 1;
}
.binding-action {
  font-size: 12px;
  color: var(--ink-muted);
  margin-top: 2px;
}
.toolbar {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.action-select {
  font-family: inherit;
}
.hint {
  font-size: 12px;
  color: var(--ink-muted);
  line-height: 1.5;
  margin: 0 0 8px;
}
.error-msg {
  color: var(--err);
  font-size: 12px;
  margin-top: 8px;
}
.ok-msg {
  color: var(--ok);
  font-size: 12px;
  margin-top: 8px;
}
.btn.tiny {
  padding: 3px 8px;
  font-size: 11px;
  border-radius: var(--radius-sm);
}
</style>
