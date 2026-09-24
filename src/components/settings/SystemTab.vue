<script setup lang="ts">
import { onMounted, ref, toRef } from "vue";
import type { HealthInfo, PetInteractionSettings, SettingsInfo } from "../../types";
import type { SettingsState } from "../../composables/useSettings";
import { tauriAvailable } from "../../tauri";
import { useAssistantAvatar } from "../../composables/useAssistantAvatar";
import AssistantAvatar from "../AssistantAvatar.vue";
import PetModelPicker from "../PetModelPicker.vue";
import { usePetInteraction } from "./composables/usePetInteraction";
import { usePetModelSelect } from "./composables/usePetModelSelect";

const props = defineProps<{
  state: SettingsState;
  healthInfo: HealthInfo | null;
  settingsInfo: SettingsInfo | null;
}>();

defineEmits<{
  restart: [];
  toggleWindowStartup: [key: "autoOpenMain" | "autoOpenPet", value: boolean];
  changePetSize: [percent: number];
}>();

const settingsInfoRef = toRef(props, "settingsInfo");
const { interactionForm, interactionMode, onInteractionModeChange, onInteractionNum } =
  usePetInteraction(settingsInfoRef);

const {
  petModels,
  activePetModelId,
  petModelSwitching,
  petModelMsg,
  activePetModelLabel,
  onPickPetModel,
} = usePetModelSelect();

const { avatarUrl, avatarPath, loadAvatar, setAvatarFromFile, resetAvatar } =
  useAssistantAvatar();
const avatarMsg = ref("");
const avatarBusy = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

onMounted(() => {
  void loadAvatar(true);
});

async function onPickAvatar(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!tauriAvailable()) {
    avatarMsg.value = "仅桌面端可保存自定义头像";
    return;
  }
  avatarBusy.value = true;
  avatarMsg.value = "";
  try {
    await setAvatarFromFile(file);
    avatarMsg.value = "头像已保存";
  } catch (e) {
    avatarMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    avatarBusy.value = false;
  }
}

async function onResetAvatar() {
  if (!tauriAvailable()) return;
  avatarBusy.value = true;
  try {
    await resetAvatar();
    avatarMsg.value = "已恢复默认头像";
  } catch (e) {
    avatarMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    avatarBusy.value = false;
  }
}
</script>

<template>
  <label class="group-title">助手头像</label>
  <div class="avatar-row">
    <AssistantAvatar :size="48" variant="welcome" />
    <div class="avatar-actions">
      <button
        class="btn small"
        type="button"
        :disabled="!tauriAvailable() || avatarBusy"
        @click="fileInput?.click()"
      >
        {{ avatarBusy ? "处理中…" : "上传图片" }}
      </button>
      <button
        class="btn small"
        type="button"
        :disabled="!tauriAvailable() || avatarBusy || !avatarUrl"
        @click="onResetAvatar"
      >
        恢复默认
      </button>
    </div>
  </div>
  <input
    ref="fileInput"
    class="hidden-input"
    type="file"
    accept="image/png,image/jpeg,image/webp,image/gif"
    @change="onPickAvatar"
  />
  <p v-if="avatarMsg" class="hint">{{ avatarMsg }}</p>
  <p class="hint">
    文件路径（agent 可直接改写，保存后聊天里生效）：
    <code>{{ avatarPath || "$COS_HOME/assistant-avatar.png" }}</code>
  </p>

  <label class="group-title">启动窗口</label>
  <div class="sidecar-row">
    <span>启动时打开主窗口</span>
    <label class="switch">
      <input
        type="checkbox"
        :checked="state.windowStartup.autoOpenMain"
        :disabled="!tauriAvailable()"
        @change="
          $emit('toggleWindowStartup', 'autoOpenMain', ($event.target as HTMLInputElement).checked)
        "
      />
      <span class="slider"></span>
    </label>
  </div>
  <div class="sidecar-row">
    <span>启动时打开桌宠</span>
    <label class="switch">
      <input
        type="checkbox"
        :checked="state.windowStartup.autoOpenPet"
        :disabled="!tauriAvailable()"
        @change="
          $emit('toggleWindowStartup', 'autoOpenPet', ($event.target as HTMLInputElement).checked)
        "
      />
      <span class="slider"></span>
    </label>
  </div>
  <div class="sidecar-row">
    <span>桌宠大小</span>
    <span class="pet-size-val">{{ state.petSizePercent }}%</span>
  </div>
  <div class="pet-size-row">
    <input
      class="pet-size-slider"
      type="range"
      min="50"
      max="200"
      step="5"
      :value="state.petSizePercent"
      :disabled="!tauriAvailable()"
      @input="$emit('changePetSize', Number(($event.target as HTMLInputElement).value))"
    />
  </div>

  <label class="group-title">桌宠形象</label>
  <div class="pet-model-row">
    <span>当前模型</span>
    <span class="pet-size-val">{{ activePetModelLabel }}</span>
  </div>
  <PetModelPicker
    :models="petModels"
    :active-id="activePetModelId"
    :switching="petModelSwitching"
    @select="onPickPetModel"
  />
  <p v-if="petModelMsg" class="hint">{{ petModelMsg }}</p>
  <p class="hint">
    缺少 YUI 时先执行 <code>pnpm pet:models</code>。YUI 来自 N.E.K.O，仅供本地学习评估，请勿商用分发。
  </p>

  <p class="hint">配置保存在本机；桌宠位置与大小会记住，下次启动恢复。</p>

  <label class="group-title">桌宠互动感知</label>
  <div class="sidecar-row">
    <span>模式</span>
    <select
      class="interaction-mode"
      :value="interactionMode"
      @change="onInteractionModeChange(($event.target as HTMLSelectElement).value as PetInteractionSettings['mode'])"
    >
      <option value="off">关</option>
      <option value="events">仅事件</option>
      <option value="context">带上下文</option>
    </select>
  </div>
  <details class="interaction-debug">
    <summary>互动调试参数</summary>
    <div class="debug-grid">
      <label>
        <span>静默闲时（ms）</span>
        <input
          type="number"
          min="500"
          step="500"
          :value="interactionForm.quietMs"
          @change="onInteractionNum('quietMs', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label>
        <span>触发冷却（ms）</span>
        <input
          type="number"
          min="1000"
          step="1000"
          :value="interactionForm.cooldownMs"
          @change="onInteractionNum('cooldownMs', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label>
        <span>闲时最多次数</span>
        <input
          type="number"
          min="1"
          step="1"
          :value="interactionForm.maxTriggers"
          @change="onInteractionNum('maxTriggers', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <label>
        <span>长拖阈值（ms）</span>
        <input
          type="number"
          min="500"
          step="500"
          :value="interactionForm.longHoldMs"
          @change="onInteractionNum('longHoldMs', ($event.target as HTMLInputElement).value)"
        />
      </label>
    </div>
    <p class="hint">拖动切屏 / 长拖未松手等事件，仅在 agent 闲时才可能触发搭话。</p>
  </details>

  <label class="group-title">Sidecar（agent 大脑）</label>
  <div class="sidecar-row">
    <span class="dot" :class="healthInfo?.ok ? 'on' : 'off'"></span>
    <span>{{ healthInfo ? `端口 ${settingsInfo?.sidecar?.port ?? "—"}` : "未连接" }}</span>
    <button v-if="tauriAvailable()" class="btn small" @click="$emit('restart')">重启</button>
  </div>
  <details v-if="state.sidecarLogs.length" class="mt8">
    <summary>最近日志（{{ state.sidecarLogs.length }} 条）</summary>
    <pre class="logs">{{ state.sidecarLogs.join("\n") }}</pre>
  </details>
  <label class="group-title">关于</label>
  <p class="hint">
    Diver · 桌面陪伴 Agent<br />
    框架：DeepSeek Harness（dsh-base）· 传输/记忆/提供商：自研插件 · 壳：Tauri 2
  </p>
</template>

<style scoped>
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
.group-title {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-dim);
  letter-spacing: 0.06em;
  margin-top: 4px;
}
.sidecar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink);
}
.btn.small {
  margin-left: auto;
}
.mt8 {
  margin-top: 8px;
}
.logs {
  background: var(--paper-sunken);
  border: 1px solid var(--rule);
  border-radius: var(--radius-sm);
  padding: 10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-soft);
  max-height: 160px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 4px 0 0;
}
details summary {
  font-size: 12px;
  color: var(--ink-muted);
  cursor: pointer;
}
.hint {
  font-size: 11px;
  color: var(--ink-dim);
  margin: 0;
  line-height: 1.7;
}
.interaction-mode {
  margin-left: auto;
  font-family: inherit;
}
.interaction-debug {
  margin: 4px 0 8px;
}
.interaction-debug summary {
  font-size: 12px;
  color: var(--ink-muted);
  cursor: pointer;
}
.debug-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
  margin-top: 8px;
}
.debug-grid label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ink-soft);
}
.debug-grid input {
  margin-left: auto;
  width: 88px;
  padding: 3px 6px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.pet-size-val {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
  font-size: 12px;
}
.pet-size-row {
  display: flex;
  align-items: center;
  margin: 2px 0 6px;
}
.pet-size-slider {
  width: 100%;
  accent-color: var(--ink);
}
.pet-model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink);
  margin: 2px 0 8px;
}
.switch {
  margin-left: auto;
}
</style>
