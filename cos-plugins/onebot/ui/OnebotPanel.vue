<script setup lang="ts">
// 设置页「QQ 接入」：归属绑定 + 连接状态 + 归属实例的 configDecl 表单。
// 页面由 onebot 插件提供；产品只保留 settings.tab 扩展点与基础组件。
import { computed } from "vue";
import {
  Button,
  Card,
  ConfigForm,
  Field,
  InlineNotice,
  PageHeader,
  StatusDot,
} from "@diver/plugin-ui";
import type { OnebotPanelState } from "./use-onebot-panel";
import GroupTiersEditor from "./GroupTiersEditor.vue";

const props = defineProps<{
  panel: OnebotPanelState;
  t: (key: string, fallback?: string) => string;
}>();

const panel = props.panel;
const ownerRunning = computed(
  () => panel.owner !== null && panel.runningIds.has(panel.owner),
);
const dotTone = computed(() =>
  panel.status.tone === "bad" ? "err" : panel.status.tone,
);
</script>

<template>
  <PageHeader
    title="QQ（OneBot）接入"
    description="归属全局单选：选定后仅该实例的 OneBot 插件连接 QQ，其余实例休眠（多实例配同一 wsUrl 也不会重复回复）。连接与行为参数（wsUrl / token / 群白名单 / 插话概率等）保存在归属实例自己的插件配置里，在下方编辑；未配置 wsUrl 时插件保持休眠。绑定与配置改动均需重启应用后生效。也可在「实例」页通过每行的「接 QQ」勾选调整归属。「插件」页只负责 OneBot 插件的启停，连接与行为配置统一在本页维护。"
  />

  <InlineNotice v-if="panel.notice" tone="ok">{{ panel.notice }}</InlineNotice>
  <InlineNotice v-if="panel.error" tone="err">{{ panel.error }}</InlineNotice>

  <Field label="归属实例">
    <div class="owner-picker">
      <label class="owner-option">
        <input
          v-model="panel.ownerPick"
          type="radio"
          value=""
          @change="panel.pickOwner()"
        />
        未绑定（任意实例配了 wsUrl 都可连接，不推荐多实例使用）
      </label>
      <label v-for="inst in panel.instances" :key="inst.id" class="owner-option">
        <input
          v-model="panel.ownerPick"
          type="radio"
          :value="inst.id"
          @change="panel.pickOwner()"
        />
        {{ inst.name || inst.id }}
        <span v-if="!inst.enabled" class="state-note">（已停用）</span>
        <span v-if="panel.runningIds.has(inst.id)" class="state-note run">
          运行中
        </span>
      </label>
    </div>
  </Field>

  <label class="group-title">连接状态</label>
  <Card>
    <div class="status-row">
      <StatusDot
        class="status-dot"
        :tone="dotTone"
        :pulse="panel.statusBusy"
      />
      <div class="link-copy">
        <div class="link-title">{{ panel.status.title }}</div>
        <div v-if="panel.status.detail" class="link-detail">
          {{ panel.status.detail }}
        </div>
      </div>
      <Button
        v-if="panel.owner !== null && ownerRunning"
        variant="ghost"
        size="sm"
        :disabled="panel.statusBusy"
        @click="panel.refreshStatus()"
      >
        刷新
      </Button>
    </div>
  </Card>

  <label class="group-title">连接与行为（归属实例的插件配置）</label>
  <p v-if="panel.owner === null" class="hint">
    先在上方选择归属实例。未绑定归属时 OneBot 仍是旧的「配置即归属」行为，但本页不编辑任何实例的配置；
    绑定后即可在此维护（也可在「实例」页勾选目标实例的「接 QQ」）。
  </p>
  <p v-else-if="!ownerRunning" class="hint">
    实例 {{ panel.owner }} 未在运行（未启用或未随应用启动）。启用并重启应用后，可在此编辑它的
    OneBot 配置。
  </p>
  <template v-else>
    <InlineNotice v-if="panel.cfgNotice" tone="ok">
      {{ panel.cfgNotice }}
    </InlineNotice>
    <InlineNotice v-if="panel.cfgError" tone="err">
      {{ panel.cfgError }}
    </InlineNotice>
    <ConfigForm
      v-if="panel.config"
      :config="panel.config"
      :draft="panel.draft"
      :busy="panel.busy"
      @save="panel.save()"
    >
      <template #field-groupTiers="{ value, setValue }">
        <GroupTiersEditor
          :groups-text="String(panel.draft.groups ?? '')"
          :model-value="String(value ?? '')"
          @update:model-value="setValue($event)"
        />
      </template>
    </ConfigForm>
    <p v-if="panel.config === null && panel.cfgError === ''" class="hint">
      正在读取配置…
    </p>
  </template>

  <Button variant="ghost" size="sm" class="reload" @click="panel.reload()">
    重新加载
  </Button>
</template>

<style scoped>
.group-title {
  display: block;
  font-size: var(--text-xs);
  font-weight: 500;
  color: var(--ink-dim);
  letter-spacing: 0.06em;
  margin-top: 4px;
}
.hint {
  font-size: var(--text-xs);
  color: var(--ink-dim);
  margin: 0;
  line-height: 1.7;
}
.owner-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.owner-option {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-sm);
  color: var(--ink);
}
.owner-option input {
  accent-color: var(--accent);
  margin: 0;
}
.state-note {
  font-size: var(--text-xs);
  color: var(--ink-dim);
}
.state-note.run {
  color: var(--accent);
}
.status-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.status-dot {
  margin-top: 6px;
}
.link-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.link-title {
  font-size: var(--text-base);
  font-weight: 500;
}
.link-detail {
  font-size: var(--text-xs);
  color: var(--ink-dim);
  line-height: 1.6;
  word-break: break-all;
}
.reload {
  align-self: flex-start;
  margin-top: 4px;
}
</style>
