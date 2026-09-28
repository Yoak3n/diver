<script setup lang="ts">
// 主窗口标题栏 · 窗口控制三键（最小化 / 最大化还原 / 关闭）。
import { onMounted, onUnmounted, ref } from "vue";
import {
  onWindowResized,
  tauriAvailable,
  windowClose,
  windowIsMaximized,
  windowMinimize,
  windowToggleMaximize,
} from "../tauri";

const maximized = ref(false);
let unlistenResize: (() => void) | null = null;

async function syncMaximized() {
  maximized.value = await windowIsMaximized();
}

onMounted(() => {
  if (!tauriAvailable()) return;
  void syncMaximized();
  void onWindowResized(() => {
    void syncMaximized();
  }).then((u) => {
    unlistenResize = u;
  });
});

onUnmounted(() => {
  unlistenResize?.();
});
</script>

<template>
  <div class="win-controls" @pointerdown.stop>
    <button
      class="win-btn"
      type="button"
      title="最小化"
      aria-label="最小化"
      @click="windowMinimize()"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M1 5h8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
    </button>
    <button
      class="win-btn"
      type="button"
      :title="maximized ? '还原' : '最大化'"
      :aria-label="maximized ? '还原' : '最大化'"
      @click="windowToggleMaximize()"
    >
      <svg v-if="!maximized" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect
          x="1.2"
          y="1.2"
          width="7.6"
          height="7.6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
        />
      </svg>
      <svg v-else width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect
          x="1.2"
          y="2.8"
          width="6"
          height="6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.2"
        />
        <path d="M2.8 2.8V1.2h6v6H7.2" fill="none" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
    <button
      class="win-btn close"
      type="button"
      title="关闭"
      aria-label="关闭"
      @click="windowClose()"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path
          d="M1.5 1.5l7 7M8.5 1.5l-7 7"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.win-controls {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
}

.win-btn {
  width: 44px;
  border: none;
  background: transparent;
  color: var(--ink-muted);
  cursor: default;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 80ms ease, color 80ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .win-btn:hover {
    background: var(--paper-hover);
    color: var(--ink);
  }
  .win-btn.close:hover {
    background: var(--err);
    color: var(--paper);
  }
}
.win-btn:active {
  background: var(--paper-active);
}
.win-btn.close:active {
  background: var(--err);
  color: var(--paper);
  opacity: 0.9;
}
</style>
