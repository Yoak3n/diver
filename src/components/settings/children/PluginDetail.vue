<script setup lang="ts">
// 设置「插件」页详情：选中插件的说明、启停 / 卸载与配置表单。
// 配置有独立设置页的插件（见 PLUGIN_CONFIG_TAB）只给跳转入口，不在这里重复渲染表单。
import { computed } from "vue";
import type { PluginConfigView, PluginInfo } from "../../../api";
import type { SettingsTab } from "../../../composables/settings-tabs";
import PluginConfigForm from "./PluginConfigForm.vue";
import type { PluginConfigDraft } from "./pluginConfigValues";

const props = defineProps<{
  plugin: PluginInfo;
  config: PluginConfigView | null;
  draft: PluginConfigDraft | undefined;
  busy: boolean;
  activeProfile: string;
  configTab: { tab: SettingsTab; label: string } | null;
  /** 配置面读取失败原因（空 = 正常）。 */
  configError?: string;
}>();

const emit = defineEmits<{
  save: [id: string];
  toggle: [plugin: PluginInfo, enabled: boolean];
  uninstall: [plugin: PluginInfo];
  openTab: [tab: SettingsTab];
}>();

/** 安全模式只加载 backend，其它插件的启停与配置在此态下不可用。 */
const safeUnloaded = computed(
  () => props.activeProfile === "safe" && props.plugin.id !== "backend",
);
const toggleDisabled = computed(
  () => !props.plugin.toggleable || !props.plugin.present || props.busy || safeUnloaded.value,
);
const showConfigForm = computed(
  () => !safeUnloaded.value && props.config?.hasConfig === true && props.draft !== undefined,
);
</script>

<template>
  <section class="plugin-detail">
    <header class="detail-head">
      <div class="title-col">
        <div class="title-row">
          <span class="name">{{ plugin.displayName }}</span>
          <span class="pkg">{{ plugin.packageName }}</span>
        </div>
        <div class="badges">
          <span class="badge" :class="plugin.enabled ? 'on' : 'off'">
            {{ plugin.enabled ? "已启用" : "已禁用" }}
          </span>
          <span v-if="!plugin.present" class="badge warn">缺失</span>
          <span v-if="safeUnloaded" class="badge">safe 未加载</span>
          <span v-if="plugin.kind === 'profile'" class="badge">profile 安装 · 可卸载</span>
        </div>
      </div>
      <div class="actions">
        <button
          v-if="plugin.kind === 'profile'"
          class="btn small danger"
          :disabled="busy || activeProfile !== 'companion'"
          @click="emit('uninstall', plugin)"
        >
          卸载
        </button>
        <label class="switch">
          <input
            type="checkbox"
            :checked="plugin.enabled"
            :disabled="toggleDisabled"
            @change="emit('toggle', plugin, ($event.target as HTMLInputElement).checked)"
          />
          <span class="slider"></span>
        </label>
      </div>
    </header>

    <p class="desc">{{ plugin.description || "—" }}</p>
    <p v-if="plugin.advisory" class="advisory">{{ plugin.advisory }}</p>

    <div class="config-area">
      <p v-if="safeUnloaded" class="hint">
        安全模式下未加载该插件，回到 companion 后即可启停与配置。
      </p>
      <template v-else-if="configTab">
        <p class="hint">
          连接与行为参数在「{{ configTab.label }}」页维护（按归属实例保存），此处不重复编辑。
        </p>
        <button class="btn small" @click="emit('openTab', configTab.tab)">
          打开「{{ configTab.label }}」
        </button>
      </template>
      <p v-else-if="configError" class="hint">配置读取失败：{{ configError }}</p>
      <PluginConfigForm
        v-else-if="showConfigForm && config && draft"
        :plugin-id="plugin.id"
        :config="config"
        :draft="draft"
        :busy="busy"
        @save="emit('save', $event)"
      />
      <p v-else class="hint">该插件没有可配置项。</p>
    </div>
  </section>
</template>

<style scoped>
.plugin-detail {
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--paper-raised);
}
.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.title-col {
  min-width: 0;
}
.title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}
.pkg {
  font-size: 12px;
  color: var(--ink-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--rule-strong);
  color: var(--ink-muted);
}
.badge.on {
  color: var(--ok);
  border-color: var(--ok);
}
.badge.off {
  color: var(--ink-dim);
}
.badge.warn {
  color: var(--warn);
  border-color: var(--warn);
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.btn.small.danger {
  color: var(--err);
  border-color: var(--err-border);
}
.desc {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--ink-muted);
  line-height: 1.6;
}
.advisory {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--warn);
  line-height: 1.6;
}
.config-area {
  margin-top: 12px;
}
.hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--ink-muted);
  line-height: 1.5;
}
</style>
