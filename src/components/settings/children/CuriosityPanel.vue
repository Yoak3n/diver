<script setup lang="ts">
// 好奇心清单（只读）：待探索条目、来源、最近取词/汇报时间。
// 开关与订阅配置在「插件 → 记忆」的通用配置表单里，本组件不重复写。
import { onMounted, ref } from "vue";

import { getCuriosityApi, type CuriosityCounts, type CuriosityItem, type CuriosityReport } from "../../../api/curiosity";
import BilibiliLoginCard from "./BilibiliLoginCard.vue";
import { fmtAgo, reasonLabel, sourceLabel } from "./curiosity-display";

const items = ref<CuriosityItem[]>([]);
const counts = ref<CuriosityCounts>({ open: 0, claimed: 0, done: 0, skipped: 0, expired: 0 });
const report = ref<CuriosityReport | null>(null);
const lastScanAt = ref(0);
const error = ref("");
const loading = ref(false);

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const view = await getCuriosityApi("open", 20);
    counts.value = view.counts;
    report.value = view.report;
    lastScanAt.value = view.lastScanAt;
    items.value = [...view.items].sort((a, b) => b.score - a.score).slice(0, 8);
  } catch (err) {
    error.value = (err as Error)?.message ?? String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
});
</script>

<template>
  <section class="panel">
    <header class="head">
      <h3>好奇心清单</h3>
      <button class="btn small" type="button" :disabled="loading" @click="refresh">
        {{ loading ? "读取中…" : "刷新" }}
      </button>
    </header>

    <div class="chips">
      <span class="chip">待探索 {{ counts.open }}</span>
      <span class="chip">已完成 {{ counts.done }}</span>
      <span class="chip">上次取词 {{ fmtAgo(lastScanAt) }}</span>
      <span class="chip">上次小结 {{ report ? fmtAgo(report.lastReportAt) : "还没汇报" }}</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <ul v-if="items.length" class="items">
      <li v-for="item in items" :key="item.id">
        <span class="term">{{ item.term }}</span>
        <span class="tag">{{ reasonLabel(item.reason) }}</span>
        <span class="src">{{ sourceLabel(item.source) }}</span>
      </li>
    </ul>
    <p v-else-if="!error" class="hint">
      还没有攒到词。群聊里反复出现的词、owner 笔记里的待查项、高频实体会自动进来。
    </p>

    <p class="hint">
      开关与订阅配置在「插件 → 记忆」；空闲时按条消化，查到的结论会写回话题。
    </p>

    <BilibiliLoginCard />
  </section>
</template>

<style scoped>
.panel {
  border: 1px solid var(--rule);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  background: var(--card, #fff);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}
.head h3 {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-dim);
  letter-spacing: 0.04em;
}
.btn.small {
  font-size: 12px;
  padding: 3px 10px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.chip {
  font-size: 12px;
  color: var(--ink-soft);
  border: 1px solid var(--rule);
  border-radius: var(--radius-pill);
  padding: 3px 10px;
  background: var(--paper-sunken);
}
.items {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.items li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
}
.term {
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag {
  font-size: 11px;
  color: var(--ink-dim);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 0 6px;
  flex-shrink: 0;
}
.src {
  font-size: 11px;
  color: var(--ink-muted);
  margin-left: auto;
  flex-shrink: 0;
}
.hint,
.error {
  font-size: 11px;
  color: var(--ink-dim);
  margin: 0;
  line-height: 1.6;
}
.error {
  color: var(--danger, #c92a2a);
}
</style>
