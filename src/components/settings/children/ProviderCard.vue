<script setup lang="ts">
// 提供商卡片：点击切换激活 provider；非默认/非激活的已添加适配器可 × 移除卡片
// （只隐藏卡片，不清除已保存的端点与凭据）。
import type { ProviderConfigDecl } from "../../../types";
import { Badge, StatusDot } from "../../../plugin-ui";

defineProps<{
  decl: ProviderConfigDecl;
  active: boolean;
  removable: boolean;
  /** 必填 secret 是否已配置（红/绿点）。 */
  tone: "ok" | "err";
}>();

defineEmits<{
  select: [];
  remove: [];
}>();
</script>

<template>
  <div class="provider-card" :class="{ active }">
    <button type="button" class="provider-main" @click="$emit('select')">
      <span class="provider-card-head">
        <span class="provider-name">{{ decl.name }}</span>
        <span class="head-tags">
          <Badge v-if="decl.custom">自定义</Badge>
          <StatusDot :tone="tone" />
        </span>
      </span>
      <span class="provider-desc">{{ decl.description }}</span>
    </button>
    <button
      v-if="removable"
      type="button"
      class="provider-remove"
      title="移除卡片（保留已保存的配置）"
      @click.stop="$emit('remove')"
    >
      ×
    </button>
  </div>
</template>

<style scoped>
.provider-card {
  position: relative;
  background: var(--paper-raised);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  transition:
    border-color var(--dur-hover) ease,
    background var(--dur-hover) ease;
}
.provider-card.active {
  border-color: var(--ink);
  background: var(--paper-active);
}
.provider-main {
  display: block;
  width: 100%;
  background: transparent;
  border: none;
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  color: var(--ink);
  transition: transform var(--dur-press) var(--ease-out);
}
@media (hover: hover) and (pointer: fine) {
  .provider-main:hover {
    background: var(--paper-hover);
    border-radius: var(--radius);
  }
}
.provider-main:active {
  transform: scale(0.98);
}
.provider-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.provider-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.head-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.provider-desc {
  display: -webkit-box;
  margin-top: 6px;
  font-size: 11px;
  color: var(--ink-muted);
  line-height: 1.5;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.provider-remove {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--ink-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity var(--dur-hover) ease,
    background var(--dur-hover) ease,
    color var(--dur-hover) ease;
}
.provider-card:hover .provider-remove,
.provider-remove:focus-visible {
  opacity: 1;
}
@media (hover: hover) and (pointer: fine) {
  .provider-remove:hover {
    background: var(--paper-hover);
    color: var(--ink);
  }
}
</style>
