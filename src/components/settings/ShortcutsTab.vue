<script setup lang="ts">
// 全局快捷键设置页（热插拔：保存即注册/注销，无需重启 sidecar/应用）。
// 组合键经按键捕获生成，词法对齐 tauri-plugin-global-shortcut（global-hotkey parse_hotkey）。
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  listShortcuts,
  setShortcut,
  removeShortcut,
  suspendShortcuts,
  resumeShortcuts,
  SHORTCUT_ACTION_LABELS,
  tauriAvailable,
  type ShortcutAction,
  type ShortcutBinding,
} from "../../tauri";
import {
  eventToAccelerator,
  isCaptureCancel,
  isImeEvent,
  modifierHint,
} from "../../hotkey";

const bindings = ref<ShortcutBinding[]>([]);
const loading = ref(false);
const busyId = ref<string | null>(null);
const error = ref("");
const hint = ref("");

// 新增表单
const newAction = ref<ShortcutAction>("show-main");
const newAccelerator = ref("");
const adding = ref(false);

// 录制：null = 未录制；"__new__" = 新增表单；其余为绑定 id
const capturingId = ref<string | null>(null);
const capturePreview = ref("");

const actionLabels = SHORTCUT_ACTION_LABELS;
const actionOptions = Object.entries(actionLabels) as [ShortcutAction, string][];

async function refresh() {
  if (!tauriAvailable()) return;
  loading.value = true;
  error.value = "";
  try {
    bindings.value = await listShortcuts();
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function detachCapture() {
  capturingId.value = null;
  capturePreview.value = "";
  window.removeEventListener("keydown", onCaptureKey, true);
}

function stopCapture() {
  detachCapture();
  void resumeShortcuts().catch((e) => {
    error.value = String(e);
  });
}

function startCapture(id: string) {
  // 只拆监听，不要 resume——避免与随后的 suspend 交错
  detachCapture();
  capturingId.value = id;
  capturePreview.value = "";
  window.addEventListener("keydown", onCaptureKey, true);
  // 挂起全局热键：Windows RegisterHotKey 会吞掉已注册组合的 keydown
  void suspendShortcuts().catch((e) => {
    error.value = `挂起全局快捷键失败（录制可能收不到按键）: ${e}`;
  });
}

function onCaptureKey(e: KeyboardEvent) {
  // IME 假按键不参与录制；也不要 preventDefault，以免打断输入法
  if (isImeEvent(e)) return;

  // 录制期间吞掉按键，避免触发页面快捷键 / 输入框
  e.preventDefault();
  e.stopPropagation();

  if (isCaptureCancel(e)) {
    stopCapture();
    return;
  }

  const accel = eventToAccelerator(e);
  if (accel === null) {
    // 只按了修饰键：显示前缀提示
    capturePreview.value = modifierHint(e);
    return;
  }

  const target = capturingId.value;
  detachCapture();
  if (target === null) {
    void resumeShortcuts().catch(() => {});
    return;
  }

  void (async () => {
    try {
      if (target === "__new__") {
        newAccelerator.value = accel;
        await onAdd();
        return;
      }
      const binding = bindings.value.find((b) => b.id === target);
      if (binding) await onSaveAccelerator(binding, accel);
    } finally {
      void resumeShortcuts().catch((e) => {
        error.value = String(e);
      });
    }
  })();
}

async function onToggle(binding: ShortcutBinding, enabled: boolean) {
  if (busyId.value) return;
  busyId.value = binding.id;
  error.value = "";
  hint.value = "";
  try {
    const next = { ...binding, enabled };
    bindings.value = await setShortcut(next);
    hint.value = enabled
      ? `已注册 ${binding.accelerator}（立即生效）`
      : `已注销 ${binding.accelerator}（绑定保留）`;
  } catch (e) {
    error.value = String(e);
    await refresh().catch(() => {});
  } finally {
    busyId.value = null;
  }
}

async function onSaveAccelerator(binding: ShortcutBinding, accelerator: string) {
  const accel = accelerator.trim();
  if (!accel) return;
  if (accel === binding.accelerator) {
    hint.value = `组合键未变化（仍为 ${accel}）`;
    return;
  }
  if (busyId.value) return;
  busyId.value = binding.id;
  error.value = "";
  hint.value = "";
  // 先本地更新，避免异步保存期间 UI 仍显示旧键
  const optimistic = bindings.value.map((b) =>
    b.id === binding.id ? { ...b, accelerator: accel } : b,
  );
  bindings.value = optimistic;
  try {
    const next = { ...binding, accelerator: accel };
    bindings.value = await setShortcut(next);
    hint.value = `已更新为 ${accel}（立即生效）`;
  } catch (e) {
    error.value = String(e);
    await refresh().catch(() => {});
  } finally {
    busyId.value = null;
  }
}

async function onRemove(binding: ShortcutBinding) {
  if (busyId.value) return;
  busyId.value = binding.id;
  error.value = "";
  hint.value = "";
  try {
    bindings.value = await removeShortcut(binding.id);
    hint.value = `已移除 ${binding.accelerator}`;
  } catch (e) {
    error.value = String(e);
    await refresh().catch(() => {});
  } finally {
    busyId.value = null;
  }
}

async function onAdd() {
  const accel = newAccelerator.value.trim();
  if (!accel || adding.value) return;
  adding.value = true;
  error.value = "";
  hint.value = "";
  try {
    const binding: ShortcutBinding = {
      id: `custom-${Date.now().toString(36)}`,
      accelerator: accel,
      action: newAction.value,
      enabled: true,
    };
    bindings.value = await setShortcut(binding);
    newAccelerator.value = "";
    hint.value = `已注册 ${accel}（立即生效）`;
  } catch (e) {
    error.value = String(e);
    await refresh().catch(() => {});
  } finally {
    adding.value = false;
  }
}

onMounted(refresh);
onBeforeUnmount(() => {
  detachCapture();
  void resumeShortcuts().catch(() => {});
});
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
            :class="{ recording: capturingId === b.id }"
            :disabled="busyId === b.id"
            :title="capturingId === b.id ? '按 Esc 取消' : '点击录制组合键'"
            @click="
              capturingId === b.id ? stopCapture() : startCapture(b.id)
            "
          >
            <template v-if="capturingId === b.id">
              {{ capturePreview || "" }}按下快捷键…（Esc 取消）
            </template>
            <template v-else>{{ b.accelerator }}</template>
          </button>
          <button
            type="button"
            class="btn tiny"
            :disabled="busyId === b.id || capturingId === b.id"
            title="重新录制"
            @click="startCapture(b.id)"
          >
            录制
          </button>
        </div>
        <div class="binding-action">{{ actionLabels[b.action] }}</div>
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
      :class="{ recording: capturingId === '__new__' }"
      :disabled="adding"
      :title="capturingId === '__new__' ? '按 Esc 取消' : '点击录制组合键'"
      @click="
        capturingId === '__new__' ? stopCapture() : startCapture('__new__')
      "
    >
      <template v-if="capturingId === '__new__'">
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
