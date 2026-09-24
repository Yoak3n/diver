<script setup lang="ts">
// L0 Presence HSM：只展示 Live 子树（Resting / Attending / Solitary 及叶子）。
// Companion · Off · On · Booting 省略不画；当前叶子及其祖先路径高亮。

const props = defineProps<{
  /** 当前叶子相位（空串表示未知） */
  phase: string;
  enabled: boolean;
}>();

type NodeId =
  | "live"
  | "resting"
  | "passive"
  | "attending"
  | "ambient"
  | "observing"
  | "receptive"
  | "conversation"
  | "listening"
  | "thinking"
  | "delivering"
  | "solitary"
  | "dreaming"
  | "exploring";

/** 叶子相位 → Live 子树内祖先路径（含自身）。 */
const PATHS: Record<string, NodeId[]> = {
  passive: ["live", "resting", "passive"],
  observing: ["live", "attending", "ambient", "observing"],
  receptive: ["live", "attending", "ambient", "receptive"],
  listening: ["live", "attending", "conversation", "listening"],
  thinking: ["live", "attending", "conversation", "thinking"],
  delivering: ["live", "attending", "conversation", "delivering"],
  dreaming: ["live", "solitary", "dreaming"],
  exploring: ["live", "solitary", "exploring"],
};

type Box = {
  id: NodeId;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "super" | "leaf";
};

const BOXES: Box[] = [
  { id: "live", label: "Live", x: 16, y: 16, w: 668, h: 300, kind: "super" },
  { id: "resting", label: "Resting", x: 36, y: 40, w: 300, h: 52, kind: "super" },
  { id: "passive", label: "Passive · 被动应答", x: 52, y: 56, w: 160, h: 28, kind: "leaf" },
  { id: "attending", label: "Attending", x: 36, y: 108, w: 340, h: 188, kind: "super" },
  { id: "ambient", label: "Ambient", x: 52, y: 132, w: 300, h: 70, kind: "super" },
  { id: "observing", label: "Observing", x: 64, y: 158, w: 130, h: 30, kind: "leaf" },
  { id: "receptive", label: "Receptive", x: 206, y: 158, w: 130, h: 30, kind: "leaf" },
  { id: "conversation", label: "Conversation", x: 52, y: 218, w: 300, h: 64, kind: "super" },
  { id: "listening", label: "Listening", x: 64, y: 244, w: 86, h: 28, kind: "leaf" },
  { id: "thinking", label: "Thinking", x: 158, y: 244, w: 86, h: 28, kind: "leaf" },
  { id: "delivering", label: "Delivering", x: 252, y: 244, w: 86, h: 28, kind: "leaf" },
  { id: "solitary", label: "Solitary", x: 400, y: 40, w: 260, h: 256, kind: "super" },
  { id: "dreaming", label: "Dreaming · 整理记忆", x: 424, y: 100, w: 212, h: 40, kind: "leaf" },
  { id: "exploring", label: "Exploring · 网络探索", x: 424, y: 170, w: 212, h: 40, kind: "leaf" },
];

function activeSet(): Set<string> {
  return new Set(PATHS[props.phase] ?? []);
}

function nodeFill(kind: Box["kind"], on: boolean): string {
  if (!on) return kind === "super" ? "#f7fafc" : "#ffffff";
  if (kind === "leaf") return props.enabled ? "#e7f5ff" : "#f1f3f5";
  return "#e8f5ee";
}

function nodeStroke(on: boolean): string {
  if (!on) return "#cbd5e0";
  return props.enabled ? "#2f9e44" : "#868e96";
}
</script>

<template>
  <div
    class="hsm-graph"
    role="img"
    :aria-label="`存在感状态机 Live 子树，当前相位 ${phase || '未知'}`"
  >
    <svg viewBox="0 0 700 340" xmlns="http://www.w3.org/2000/svg">
      <g v-for="b in BOXES" :key="b.id">
        <rect
          :x="b.x"
          :y="b.y"
          :width="b.w"
          :height="b.h"
          :rx="b.kind === 'leaf' ? 8 : 10"
          :fill="nodeFill(b.kind, activeSet().has(b.id))"
          :stroke="nodeStroke(activeSet().has(b.id))"
          :stroke-width="activeSet().has(b.id) ? 1.8 : 0.8"
          :opacity="activeSet().has(b.id) ? 1 : 0.7"
        />
        <text
          v-if="b.kind !== 'leaf'"
          :x="b.x + 12"
          :y="b.y + 18"
          class="node-label"
          :class="{ active: activeSet().has(b.id) }"
        >
          {{ b.label }}
        </text>
        <text
          v-else
          :x="b.x + b.w / 2"
          :y="b.y + b.h / 2 + 1"
          text-anchor="middle"
          dominant-baseline="central"
          class="node-label"
          :class="{ active: activeSet().has(b.id) }"
        >
          {{ b.label }}
        </text>
      </g>
      <text x="16" y="332" class="footnote">
        仅 Live 子树 · 绿框 = 当前活跃路径 · 灰框 = 未激活 · 对外 phase() 为叶子名
      </text>
    </svg>
  </div>
</template>

<style scoped>
.hsm-graph {
  width: 100%;
  border: 1px solid var(--rule);
  border-radius: var(--radius-sm);
  background: var(--paper-sunken);
  overflow: hidden;
}
.hsm-graph svg {
  display: block;
  width: 100%;
  height: auto;
}
.node-label {
  font-size: 12px;
  fill: var(--ink-muted);
  font-family: inherit;
}
.node-label.active {
  fill: var(--ink);
  font-weight: 600;
}
.footnote {
  font-size: 10px;
  fill: var(--ink-dim);
  font-family: inherit;
}
</style>
