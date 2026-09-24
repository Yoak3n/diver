<script setup lang="ts">
import PetModelPicker from "../../components/PetModelPicker.vue";
import type { PetModelProfile } from "../models";

defineProps<{
  models: PetModelProfile[];
  activeId: string;
  switching: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  close: [];
}>();
</script>

<template>
  <div class="model-picker-panel" @pointerdown.stop>
    <div class="model-picker-head">
      <span class="model-picker-title">切换模型</span>
      <button class="model-picker-close" title="关闭" @click="emit('close')">×</button>
    </div>
    <PetModelPicker
      compact
      :models="models"
      :active-id="activeId"
      :switching="switching"
      @select="emit('select', $event)"
    />
    <p class="model-picker-hint">YUI 来自 N.E.K.O，仅供本地学习评估。</p>
  </div>
</template>
