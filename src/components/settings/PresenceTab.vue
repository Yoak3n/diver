<script setup lang="ts">
// 存在感状态机（L0 Presence FSM）独立页签：图形化 HSM + 当前相位 + L2 记账。
import { usePresenceStatus } from "../../composables/usePresenceStatus";
import { tauriAvailable } from "../../tauri";
import type { PresencePhase } from "../../ipc/presence";
import PresenceHsmGraph from "./children/PresenceHsmGraph.vue";

const {
  snapshot,
  phase,
  phaseLabel,
  regimeLabel,
  enabled,
  userInputActive,
  refresh,
} = usePresenceStatus();

/** 当前相位允许的能力（对齐 docs/companion-presence-fsm.md §4 能力矩阵）。 */
const CAPABILITIES: Record<string, { key: string; label: string; on: boolean }[]> = {
  off: [],
  booting: [
    { key: "accept_user_input", label: "接受输入", on: false },
    { key: "idle_motion", label: "待机动作", on: false },
    { key: "react_to_pet", label: "桌宠互动", on: false },
  ],
  passive: [
    { key: "accept_user_input", label: "接受输入", on: true },
    { key: "auto_tts", label: "自动朗读", on: true },
    { key: "memory_dream", label: "记忆整理", on: true },
    { key: "web_explore", label: "网络探索", on: true },
  ],
  observing: [
    { key: "accept_user_input", label: "接受输入", on: true },
    { key: "proactive_inject", label: "主动搭话", on: false },
    { key: "auto_tts", label: "自动朗读", on: true },
    { key: "memory_dream", label: "记忆整理", on: true },
    { key: "web_explore", label: "网络探索", on: true },
  ],
  receptive: [
    { key: "accept_user_input", label: "接受输入", on: true },
    { key: "proactive_inject", label: "主动搭话", on: true },
    { key: "auto_tts", label: "自动朗读", on: true },
    { key: "memory_dream", label: "记忆整理", on: true },
    { key: "web_explore", label: "网络探索", on: true },
  ],
  listening: [
    { key: "accept_user_input", label: "接受输入", on: true },
    { key: "accept_steer", label: "可插话", on: true },
    { key: "auto_tts", label: "自动朗读", on: true },
  ],
  thinking: [
    { key: "accept_user_input", label: "接受输入（插话）", on: true },
    { key: "accept_steer", label: "可插话", on: true },
    { key: "auto_tts", label: "自动朗读", on: false },
  ],
  delivering: [
    { key: "accept_user_input", label: "接受输入", on: true },
    { key: "accept_steer", label: "可插话", on: true },
  ],
  dreaming: [
    { key: "accept_user_input", label: "接受输入（可打断）", on: true },
    { key: "accept_steer", label: "可插话（让路）", on: true },
  ],
  exploring: [
    { key: "accept_user_input", label: "接受输入（可打断）", on: true },
    { key: "accept_steer", label: "可插话（让路）", on: true },
    { key: "web_explore", label: "网络探索", on: true },
  ],
};

function capsOf(p: string) {
  return CAPABILITIES[p] ?? [];
}

function fmtAgo(ms: number): string {
  if (!ms) return "—";
  const d = Date.now() - ms;
  if (d < 0) return "刚刚";
  if (d < 60_000) return `${Math.floor(d / 1000)}s 前`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m 前`;
  return `${Math.floor(d / 3_600_000)}h 前`;
}

const phaseHints: Partial<Record<PresencePhase, string>> = {
  off: "已关闭，不接受任何对外行为",
  booting: "启动缓冲中，短暂静默后进入观察",
  passive: "Regime 压制：只应答，不主动",
  observing: "在场感知，等待静默升为可搭话",
  receptive: "可主动搭话 / 可跑记忆整理",
  listening: "对话回合：正在听你说",
  thinking: "回合工作中（working）",
  delivering: "TTS / 动作输出中",
  dreaming: "后台记忆巩固（可被打断）",
  exploring: "记忆取词 → 互联网探索（可被打断）",
};
</script>

<template>
  <div class="presence-tab" role="status" aria-live="polite">
    <header class="hero">
      <div class="hero-main">
        <span class="dot" :class="enabled ? 'on' : 'off'"></span>
        <div>
          <div class="title">
            {{ phaseLabel }}
            <code class="raw">{{ phase || "—" }}</code>
          </div>
          <p class="hint">
            {{ (phase && phaseHints[phase as PresencePhase]) || "读取状态机中…" }}
          </p>
        </div>
      </div>
      <button
        v-if="tauriAvailable()"
        class="btn small"
        type="button"
        @click="refresh"
      >
        刷新
      </button>
    </header>

    <div class="meta-row">
      <span class="chip">Regime · {{ regimeLabel }}</span>
      <span class="chip">启用 · {{ enabled ? "是" : "否" }}</span>
      <span class="chip">输入中 · {{ userInputActive ? "是" : "否" }}</span>
    </div>

    <PresenceHsmGraph :phase="phase" :enabled="enabled" />

    <section class="panel">
      <h3>当前能力（L1）</h3>
      <div class="caps">
        <span
          v-for="c in capsOf(phase)"
          :key="c.key"
          class="cap"
          :class="{ on: c.on }"
          :title="c.key"
        >
          {{ c.label }}
        </span>
        <span v-if="!capsOf(phase).length" class="hint">当前相位无对外能力</span>
      </div>
    </section>

    <section v-if="snapshot" class="panel">
      <h3>Proactive 记账（L2）</h3>
      <div class="grid">
        <span>最近用户发言：{{ fmtAgo(snapshot.proactive.last_user_chat_at) }}</span>
        <span>最近对话：{{ fmtAgo(snapshot.proactive.last_chat_at) }}</span>
        <span>最近主动：{{ fmtAgo(snapshot.proactive.last_proactive_at) }}</span>
        <span>
          窗口触发：{{ snapshot.proactive.window_triggers }}/{{ snapshot.proactive.max_triggers }}
        </span>
        <span>静默阈值：{{ (snapshot.proactive.quiet_ms / 1000).toFixed(0) }}s</span>
        <span>冷却：{{ (snapshot.proactive.cooldown_ms / 1000).toFixed(0) }}s</span>
      </div>
    </section>

    <p v-else-if="!tauriAvailable()" class="hint">非 Tauri 环境无法读取状态机。</p>
    <p class="hint">
      完整迁移表与设计见 <code>docs/companion-presence-fsm.md</code>
    </p>
  </div>
</template>

<style scoped>
.presence-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
  color: var(--ink);
}
.hero {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.hero-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  flex: 1;
  min-width: 0;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-top: 6px;
  flex-shrink: 0;
}
.dot.on {
  background: var(--ok, #2f9e44);
}
.dot.off {
  background: var(--ink-dim);
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.raw {
  font-size: 12px;
  font-weight: 400;
  color: var(--ink-dim);
  background: var(--paper-sunken);
  border-radius: 4px;
  padding: 2px 8px;
}
.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  font-size: 12px;
  color: var(--ink-soft);
  border: 1px solid var(--rule);
  border-radius: var(--radius-pill);
  padding: 3px 10px;
  background: var(--paper-sunken);
}
.panel {
  border: 1px solid var(--rule);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  background: var(--card, #fff);
}
.panel h3 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-dim);
  letter-spacing: 0.04em;
}
.caps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.cap {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--rule);
  color: var(--ink-dim);
  background: transparent;
}
.cap.on {
  color: var(--ink);
  border-color: color-mix(in srgb, var(--ok, #2f9e44) 45%, var(--rule));
  background: color-mix(in srgb, var(--ok, #2f9e44) 10%, transparent);
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 14px;
  font-size: 12px;
  color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.hint {
  font-size: 11px;
  color: var(--ink-dim);
  margin: 0;
  line-height: 1.6;
}
</style>
