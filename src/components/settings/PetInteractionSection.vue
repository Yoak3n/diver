<script setup lang="ts">
// 系统设置 · 桌宠互动感知区块（模式 + 调试参数；自包含 usePetInteraction）。
import { toRef } from "vue";
import type { PetInteractionSettings, SettingsInfo } from "../../types";
import { usePetInteraction } from "./composables/usePetInteraction";

const props = defineProps<{ settingsInfo: SettingsInfo | null }>();

const { interactionForm, interactionMode, onInteractionModeChange, onInteractionNum } =
  usePetInteraction(toRef(props, "settingsInfo"));
</script>

<template>
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
    <p class="hint">拖动切屏 / 长时间拖动等事件，仅在 agent 闲时才可能触发搭话。</p>
  </details>
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
</style>
