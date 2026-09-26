<script setup lang="ts">
// 首启/启动准备遮罩：订阅 Rust `setup://progress`，显示解压 / Node 准备进度。
// 仅在真实 bootstrap（解压 / Node 准备）阶段出场；平时启动不显示。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { onTauriEvent, tauriAvailable, getSidecarStatus } from "../tauri";

export interface SetupProgress {
  phase: string;
  message: string;
  percent: number;
  done: boolean;
  error?: string;
}

const BOOTSTRAP_PHASES = new Set(["extract", "node"]);
const active = ref(false);
const phase = ref("start");
const message = ref("正在准备运行环境…");
const percent = ref(0);
const error = ref<string | null>(null);

const barStyle = computed(() => ({ width: `${Math.max(2, Math.min(100, percent.value))}%` }));
const title = computed(() => {
  if (error.value) return "启动失败";
  switch (phase.value) {
    case "extract":
      return "正在解压运行依赖";
    case "node":
      return "正在准备 Node 运行时";
    case "ready":
      return "就绪";
    default:
      return "正在启动 Diver";
  }
});

let unlisten: (() => void) | null = null;
let readyUnlisten: (() => void) | null = null;
let hideTimer = 0;
let pollTimer = 0;

function apply(p: SetupProgress) {
  if (!p) return;
  if (p.phase === "ready" && p.done) {
    percent.value = 100;
    message.value = p.message || "就绪";
    error.value = null;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      active.value = false;
    }, 280);
    return;
  }
  if (p.phase === "error") {
    error.value = p.error || p.message;
    message.value = p.message;
    percent.value = 100;
    active.value = true;
    return;
  }
  // 平时启动（start 阶段拉 sidecar）不显示；只有解压 / Node 准备等真实 bootstrap 才出场。
  // done=true 的完成态不点亮遮罩：例行检查的「已就绪」不应让覆层闪现；
  // 真实的首启流程一定会先出现 done=false 的进行态。
  if (!BOOTSTRAP_PHASES.has(p.phase) || p.done) return;
  active.value = true;
  phase.value = p.phase;
  message.value = p.message || "正在准备运行环境…";
  percent.value = p.percent ?? 0;
}

async function pullLatest() {
  if (!tauriAvailable()) return;
  try {
    const p = await invoke<SetupProgress | null>("get_setup_progress");
    if (p) apply(p);
  } catch {
    /* ignore */
  }
  try {
    const s = await getSidecarStatus();
    if (s.state === "running") {
      percent.value = 100;
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        active.value = false;
      }, 200);
    } else if (s.state === "crashed" && !error.value) {
      error.value = "助手启动失败，请查看日志";
      active.value = true;
    }
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  if (!tauriAvailable()) {
    active.value = false;
    return;
  }
  void pullLatest();
  // 轮询兜底：WebView 晚于启动线程时不会丢进度
  pollTimer = window.setInterval(() => {
    void pullLatest();
  }, 400);
  void onTauriEvent<SetupProgress>("setup://progress", apply).then((u) => {
    unlisten = u;
    void pullLatest();
  });
  void onTauriEvent("backend://ready", () => {
    percent.value = 100;
    message.value = "就绪";
    error.value = null;
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      active.value = false;
    }, 200);
  }).then((u) => {
    readyUnlisten = u;
  });
});

onBeforeUnmount(() => {
  unlisten?.();
  readyUnlisten?.();
  window.clearTimeout(hideTimer);
  window.clearInterval(pollTimer);
});
</script>

<template>
  <div v-if="active" class="setup-overlay" role="status" aria-live="polite">
    <div class="setup-card">
      <div class="setup-title">{{ title }}</div>
      <div class="setup-msg">{{ error ?? message }}</div>
      <div v-if="!error" class="setup-track">
        <div class="setup-bar" :style="barStyle" />
      </div>
      <div v-if="!error" class="setup-pct">{{ Math.round(percent) }}%</div>
    </div>
  </div>
</template>

<style scoped>
.setup-overlay {
  position: absolute;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--paper, #faf8f5) 88%, transparent);
  backdrop-filter: blur(6px);
}
.setup-card {
  width: min(360px, 86vw);
  padding: 28px 24px;
  border-radius: 14px;
  background: var(--card, #fff);
  border: 1px solid color-mix(in srgb, var(--ink, #1a1a1a) 8%, transparent);
  box-shadow: 0 12px 40px color-mix(in srgb, var(--ink, #000) 8%, transparent);
  text-align: center;
}
.setup-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}
.setup-msg {
  font-size: 13px;
  opacity: 0.75;
  min-height: 2.4em;
  line-height: 1.5;
  word-break: break-all;
}
.setup-track {
  margin-top: 18px;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink, #000) 8%, transparent);
  overflow: hidden;
}
.setup-bar {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #6b8cff, #8b5cf6);
  transition: width 0.25s ease;
}
.setup-pct {
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}
</style>
