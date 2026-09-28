<script setup lang="ts">
// 系统设置页：应用图标 / 启动窗口 / 桌宠形象 / 互动感知 / Sidecar / 关于。
// 分层：AppIconSection.vue 应用图标 | PetInteractionSection.vue 互动感知；
// 本文件保留启动窗口、桌宠形象、Sidecar 状态与关于。
import type { HealthInfo, SettingsInfo } from "../../types";
import type { SettingsState } from "../../composables/useSettings";
import { tauriAvailable } from "../../tauri";
import PetModelPicker from "../PetModelPicker.vue";
import AppIconSection from "./AppIconSection.vue";
import PetInteractionSection from "./PetInteractionSection.vue";
import { usePetModelSelect } from "./composables/usePetModelSelect";

defineProps<{
  state: SettingsState;
  healthInfo: HealthInfo | null;
  settingsInfo: SettingsInfo | null;
}>();

defineEmits<{
  restart: [];
  toggleWindowStartup: [key: "autoOpenMain" | "autoOpenPet", value: boolean];
  changePetSize: [percent: number];
}>();

const {
  petModels,
  activePetModelId,
  petModelSwitching,
  petModelMsg,
  activePetModelLabel,
  onPickPetModel,
} = usePetModelSelect();
</script>

<template>
  <AppIconSection />

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
    此处为应用级默认桌宠模型（未指定桌宠的实例跟随它）；单个实例可在「实例」页固定自己的模型。
    缺少 YUI 时先执行 <code>pnpm pet:models</code>。YUI 来自 N.E.K.O，仅供本地学习评估，请勿商用分发。
  </p>

  <p class="hint">配置保存在本机；桌宠位置与大小会记住，下次启动恢复。</p>

  <PetInteractionSection :settings-info="settingsInfo" />

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
