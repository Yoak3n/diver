<script setup lang="ts">
// 群聊档位编辑器：每行一个监听群 + 档位下拉；「常规」= 从配置里移除。
// 数据仍是 configDecl 的 groupTiers 文本（群号=档位），这里只做结构化读写。
import { computed } from "vue";
import { Select } from "@diver/plugin-ui";
import {
  GROUP_TIER_OPTIONS,
  parseGroupIds,
  parseTierMap,
  setGroupTier,
  tierOf,
} from "./group-tiers";

const props = defineProps<{
  groupsText: string;
  modelValue: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const groupIds = computed(() => parseGroupIds(props.groupsText));
const tiers = computed(() => parseTierMap(props.modelValue));

function change(groupId: string, tier: string): void {
  emit(
    "update:modelValue",
    setGroupTier(props.modelValue, props.groupsText, groupId, tier),
  );
}
</script>

<template>
  <div class="tier-editor">
    <p v-if="groupIds.length === 0" class="tier-hint">
      先在「监听的群」里填入群号，这里会按群逐个出现。
    </p>
    <div v-else class="tier-rows">
      <div v-for="groupId in groupIds" :key="groupId" class="tier-row">
        <span class="tier-group">{{ groupId }}</span>
        <Select
          size="sm"
          :model-value="tierOf(tiers, groupId)"
          :options="GROUP_TIER_OPTIONS"
          @update:model-value="change(groupId, $event)"
        />
      </div>
    </div>
    <p class="tier-hint">
      档位只调主动插话概率与冷却；被 @ / 提及 / 引用不受影响。
    </p>
  </div>
</template>

<style scoped>
.tier-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tier-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tier-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 9rem;
  align-items: center;
  gap: 8px;
}
.tier-group {
  overflow: hidden;
  font-family: ui-monospace, monospace;
  font-size: var(--text-sm);
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tier-hint {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--ink-dim);
  line-height: 1.6;
}
</style>
