<script setup lang="ts">
// 设置「插件」页的二级菜单：按内置 / 已安装分组，选中项交给父级渲染详情。
import { computed } from "vue";
import type { PluginInfo } from "../../../api";

const props = defineProps<{
  plugins: PluginInfo[];
  selectedId: string;
}>();

const emit = defineEmits<{
  select: [id: string];
}>();

interface NavGroup {
  key: string;
  label: string;
  items: PluginInfo[];
}

const groups = computed<NavGroup[]>(() => {
  const out: NavGroup[] = [];
  const internal = props.plugins.filter((p) => p.kind === "internal");
  const profile = props.plugins.filter((p) => p.kind === "profile");
  if (internal.length > 0) out.push({ key: "internal", label: "内置", items: internal });
  if (profile.length > 0) out.push({ key: "profile", label: "已安装", items: profile });
  return out;
});

/** 状态点：绿 = 已启用，灰 = 已禁用，红 = 包体缺失。 */
function stateOf(p: PluginInfo): "on" | "off" | "missing" {
  if (!p.present) return "missing";
  return p.enabled ? "on" : "off";
}
</script>

<template>
  <nav class="plugin-nav">
    <template v-for="g in groups" :key="g.key">
      <div class="nav-group">{{ g.label }}</div>
      <button
        v-for="p in g.items"
        :key="p.id"
        class="nav-item"
        :class="{ active: p.id === selectedId, off: !p.enabled && p.present }"
        type="button"
        @click="emit('select', p.id)"
      >
        <span class="dot" :class="stateOf(p)"></span>
        <span class="nav-label">{{ p.displayName }}</span>
        <span v-if="!p.present" class="nav-flag">缺失</span>
      </button>
    </template>
  </nav>
</template>

<style scoped>
.plugin-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.nav-group {
  padding: 10px 8px 4px;
  font-size: 11px;
  color: var(--ink-dim);
  letter-spacing: 0.06em;
}
.nav-group:first-child {
  padding-top: 0;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink-muted);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    background var(--dur-hover) ease,
    color var(--dur-hover) ease;
}
@media (hover: hover) and (pointer: fine) {
  .nav-item:hover {
    color: var(--ink);
    background: var(--paper-hover);
  }
}
.nav-item.active {
  color: var(--ink);
  background: var(--paper-active);
  font-weight: 500;
}
.dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--ink-dim);
}
.dot.on {
  background: var(--ok);
}
.dot.missing {
  background: var(--err);
}
.nav-item.off .nav-label {
  opacity: 0.62;
}
.nav-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-flag {
  font-size: 10px;
  color: var(--warn);
}
</style>
