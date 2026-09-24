<script setup lang="ts">
import { PET_DRAG_LONG_PRESS_MS } from "../composables/usePetDrag";

defineProps<{
  x: number;
  y: number;
}>();
</script>

<template>
  <div class="drag-charge" :style="{ left: `${x}px`, top: `${y}px` }" aria-hidden="true">
    <svg class="drag-charge-ring" viewBox="0 0 40 40">
      <circle class="drag-charge-track" cx="20" cy="20" r="16" />
      <circle
        class="drag-charge-fill"
        cx="20"
        cy="20"
        r="16"
        :style="{ animationDuration: `${PET_DRAG_LONG_PRESS_MS}ms` }"
      />
    </svg>
    <span class="drag-charge-hint">按住拖动</span>
  </div>
</template>
