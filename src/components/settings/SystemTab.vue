<script setup lang="ts">
import type { HealthInfo, SettingsInfo } from "../../types";
import type { SettingsState } from "../../composables/useSettings";
import { tauriAvailable } from "../../tauri";

defineProps<{
  state: SettingsState;
  healthInfo: HealthInfo | null;
  settingsInfo: SettingsInfo | null;
}>();

defineEmits<{
  restart: [];
  toggleWindowStartup: [key: "autoOpenMain" | "autoOpenPet", value: boolean];
}>();
</script>

<template>
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
  <p class="hint">配置保存在本机，下次启动时生效。</p>

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
  color: #8d89a1;
  letter-spacing: 1px;
  margin-top: 4px;
}
.sidecar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #b9b5cc;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6f6b85;
}
.dot.on {
  background: #59d99a;
  box-shadow: 0 0 6px #59d99a;
}
.dot.off {
  background: #d35d5d;
}
.btn.small {
  padding: 4px 12px;
  font-size: 12px;
  margin-left: auto;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #e8e6f0;
  border-radius: 10px;
  cursor: pointer;
  font-family: inherit;
}
.mt8 {
  margin-top: 8px;
}
.logs {
  background: #141420;
  border-radius: 8px;
  padding: 10px;
  font-size: 11px;
  line-height: 1.5;
  color: #9a96ad;
  max-height: 160px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 4px 0 0;
}
details summary {
  font-size: 12px;
  color: #8d89a1;
  cursor: pointer;
}
.hint {
  font-size: 11px;
  color: #6f6b85;
  margin: 0;
  line-height: 1.7;
}
/* 开关 */
.switch {
  position: relative;
  display: inline-block;
  width: 34px;
  height: 19px;
  margin-left: auto;
  flex-shrink: 0;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.14);
  border-radius: 19px;
  transition: background 0.2s;
  cursor: pointer;
}
.slider::before {
  content: "";
  position: absolute;
  width: 15px;
  height: 15px;
  left: 2px;
  top: 2px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}
.switch input:checked + .slider {
  background: linear-gradient(135deg, #ff9d6c, #c06ab3);
}
.switch input:checked + .slider::before {
  transform: translateX(15px);
}
.switch input:disabled + .slider {
  opacity: 0.4;
  cursor: default;
}
</style>
