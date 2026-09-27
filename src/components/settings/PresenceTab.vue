<script setup lang="ts">
// 存在感状态机（L0 Presence FSM）独立页签：图形化 HSM + 当前相位 + L2 记账。
import { computed, onMounted, ref } from "vue";
import { usePresenceStatus } from "../../composables/usePresenceStatus";
import { tauriAvailable } from "../../tauri";
import { listInstances, type InstanceMeta } from "../../ipc/instances";
import type { PresencePhase } from "../../ipc/presence";
import PresenceHsmGraph from "./children/PresenceHsmGraph.vue";
import { PHASE_HINTS, capsOf, fmtAgo } from "./children/presenceDisplay";

/** 空串 = 看 active 实例；其余值 = 定点查看该实例的 FSM。 */
const selectedInstance = ref("");
const instances = ref<InstanceMeta[]>([]);

const {
  snapshot,
  phase,
  phaseLabel,
  regimeLabel,
  enabled,
  userInputActive,
  refresh,
} = usePresenceStatus(true, selectedInstance);

onMounted(async () => {
  if (!tauriAvailable()) return;
  try {
    instances.value = (await listInstances()).filter((i) => i.enabled);
  } catch {
    /* 清单读不到时只看 active 实例 */
  }
});

/** 快照来源标注：优先实例名，未登记回退 id。 */
const instanceLabel = computed(() => {
  const id = snapshot.value?.instance;
  if (!id) return "";
  return instances.value.find((i) => i.id === id)?.name || id;
});
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
            {{ (phase && PHASE_HINTS[phase as PresencePhase]) || "读取状态机中…" }}
            <span v-if="instanceLabel" class="inst">· 实例 {{ instanceLabel }}</span>
          </p>
        </div>
      </div>
      <div v-if="instances.length" class="hero-actions">
        <select v-model="selectedInstance" class="inst-select" aria-label="选择实例">
          <option value="">活跃实例</option>
          <option v-for="i in instances" :key="i.id" :value="i.id">
            {{ i.name || i.id }}
          </option>
        </select>
        <button
          v-if="tauriAvailable()"
          class="btn small"
          type="button"
          @click="refresh"
        >
          刷新
        </button>
      </div>
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
.hero-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.inst-select {
  font-size: 12px;
  color: var(--ink);
  border: 1px solid var(--rule);
  border-radius: var(--radius-sm);
  background: var(--card, #fff);
  padding: 4px 8px;
  max-width: 140px;
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
.hint .inst {
  color: var(--ink-muted);
}
</style>
