<script setup lang="ts">
// 主窗口自定义标题栏：纸感极简 — 细线分割、无玻璃拟态。
// 拖拽区用 data-tauri-drag-region；按钮独立 no-drag。
// 分层：WindowControls.vue 窗口三键；本文件做拖拽区 + 品牌 + 状态 + 设置入口。
import { windowStartDragging, windowToggleMaximize } from "../tauri";
import { chrome } from "../composables/useChrome";
import AppIconMark from "./AppIconMark.vue";
import PresencePhaseChip from "./PresencePhaseChip.vue";
import WindowControls from "./WindowControls.vue";

withDefaults(
  defineProps<{
    subtitle?: string;
    showStatus?: boolean;
    showBack?: boolean;
  }>(),
  {
    subtitle: "",
    showStatus: false,
    showBack: false,
  },
);

defineEmits<{ back: []; "open-settings": [] }>();

function onDragPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  void windowStartDragging();
}
</script>

<template>
  <header class="titlebar">
    <div
      class="titlebar-drag"
      data-tauri-drag-region
      @pointerdown="onDragPointerDown"
      @dblclick="windowToggleMaximize()"
    >
      <button
        v-if="showBack"
        class="chrome-btn back"
        type="button"
        title="返回"
        @pointerdown.stop
        @click="$emit('back')"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M8.5 2.5L4 7l4.5 4.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <div class="brand">
        <AppIconMark :size="18" :radius="4" />
        <span class="brand-name">Diver</span>
      </div>

      <span v-if="subtitle" class="subtitle">{{ subtitle }}</span>

      <div v-else-if="showStatus" class="status">
        <span class="dot" :class="chrome.dotClass"></span>
        <span class="status-text">{{ chrome.statusText }}</span>
        <span v-if="chrome.modelLabel" class="model">{{ chrome.modelLabel }}</span>
        <PresencePhaseChip :active="showStatus" />
      </div>

      <button
        v-if="showStatus"
        class="chrome-btn settings"
        type="button"
        title="设置"
        @pointerdown.stop
        @click="$emit('open-settings')"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M6.6 1.5h2.8l.35 1.55c.4.14.78.35 1.12.62l1.5-.5 1.4 2.42-1.15 1.05c.04.24.06.5.06.76s-.02.52-.06.76l1.15 1.05-1.4 2.42-1.5-.5c-.34.27-.72.48-1.12.62L9.4 13.5H6.6l-.35-1.55a4.4 4.4 0 0 1-1.12-.62l-1.5.5-1.4-2.42 1.15-1.05A3.7 3.7 0 0 1 3.32 7.5c0-.26.02-.52.06-.76L2.23 5.69l1.4-2.42 1.5.5c.34-.27.72-.48 1.12-.62L6.6 1.5Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.15"
            stroke-linejoin="round"
          />
          <circle cx="8" cy="7.5" r="1.9" fill="none" stroke="currentColor" stroke-width="1.15" />
        </svg>
      </button>
    </div>

    <WindowControls />
  </header>
</template>

<style scoped>
.titlebar {
  height: var(--titlebar-h);
  min-height: var(--titlebar-h);
  display: flex;
  align-items: stretch;
  background: var(--paper);
  border-bottom: 1px solid var(--rule);
  -webkit-app-region: drag;
  flex-shrink: 0;
  position: relative;
  z-index: 20;
}

.titlebar-drag {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 8px 0 14px;
  cursor: default;
}

.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.brand-mark {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: var(--paper);
  background: var(--ink);
  user-select: none;
}
.brand-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.subtitle {
  font-size: 12px;
  color: var(--ink-muted);
  padding-left: 10px;
  border-left: 1px solid var(--rule);
  margin-left: 2px;
}

.status {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 12px;
  color: var(--ink-muted);
}
.status-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model {
  color: var(--ink-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.chrome-btn {
  -webkit-app-region: no-drag;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition:
    background var(--dur-hover) ease,
    color var(--dur-hover) ease,
    transform var(--dur-press) var(--ease-out);
}
@media (hover: hover) and (pointer: fine) {
  .chrome-btn:hover {
    background: var(--paper-hover);
    color: var(--ink);
  }
}
.chrome-btn:active {
  transform: scale(0.97);
}
.chrome-btn.back {
  width: 28px;
}
</style>
