<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { HealthInfo, SettingsInfo } from "../../types";
import type { SettingsState } from "../../composables/useSettings";
import { tauriAvailable, onTauriEvent } from "../../tauri";
import PetModelPicker from "../PetModelPicker.vue";
import {
  loadModelCatalog,
  pickModelProfile,
  selectModelId,
  PET_MODEL_CHANGED_EVENT,
} from "../../pet/models";
import type { PetModelProfile } from "../../pet/models";

defineProps<{
  state: SettingsState;
  healthInfo: HealthInfo | null;
  settingsInfo: SettingsInfo | null;
}>();

defineEmits<{
  restart: [];
  toggleWindowStartup: [key: "autoOpenMain" | "autoOpenPet", value: boolean];
  changePetSize: [percent: number];
}>();

// ---------- 桌宠形象模型 ----------
const petModels = ref<PetModelProfile[]>([]);
const activePetModelId = ref("");
const petModelSwitching = ref(false);
const petModelMsg = ref<string | null>(null);

const activePetModelLabel = computed(
  () => petModels.value.find((m) => m.id === activePetModelId.value)?.label ?? "—",
);

async function refreshPetModels() {
  const catalog = await loadModelCatalog();
  petModels.value = catalog.models;
  activePetModelId.value = pickModelProfile(catalog).id;
}

/** 仅持久化并广播：桌宠窗口监听后自行热切换。 */
function onPickPetModel(id: string) {
  if (petModelSwitching.value || id === activePetModelId.value) return;
  petModelSwitching.value = true;
  petModelMsg.value = null;
  try {
    selectModelId(id);
    activePetModelId.value = id;
    petModelMsg.value = "已切换；桌宠窗口会立即换装（未打开则下次启动生效）";
  } catch (err) {
    petModelMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    petModelSwitching.value = false;
  }
}

onMounted(async () => {
  try {
    await refreshPetModels();
  } catch (err) {
    petModelMsg.value = err instanceof Error ? err.message : String(err);
  }
  // 桌宠侧切换后回到设置页时同步高亮
  void onTauriEvent<{ id: string }>(PET_MODEL_CHANGED_EVENT, (p) => {
    if (p?.id) activePetModelId.value = p.id;
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "diver.pet.modelId" && e.newValue) {
      activePetModelId.value = e.newValue;
    }
  });
});
</script>

<template>
  <label class="group-title">启动窗口</label>
  <div class="sidecar-row">
    <span>启动时打开主窗口</span>
    <label class="switch">
      <input
        type="checkbox"
        :checked="state.windowStartup.autoOpenMain"
        :disabled="!tauriAvailable()"
        @change="
          $emit('toggleWindowStartup', 'autoOpenMain', ($event.target as HTMLInputElement).checked)
        "
      />
      <span class="slider"></span>
    </label>
  </div>
  <div class="sidecar-row">
    <span>启动时打开桌宠</span>
    <label class="switch">
      <input
        type="checkbox"
        :checked="state.windowStartup.autoOpenPet"
        :disabled="!tauriAvailable()"
        @change="
          $emit('toggleWindowStartup', 'autoOpenPet', ($event.target as HTMLInputElement).checked)
        "
      />
      <span class="slider"></span>
    </label>
  </div>
  <div class="sidecar-row">
    <span>桌宠大小</span>
    <span class="pet-size-val">{{ state.petSizePercent }}%</span>
  </div>
  <div class="pet-size-row">
    <input
      class="pet-size-slider"
      type="range"
      min="50"
      max="200"
      step="5"
      :value="state.petSizePercent"
      :disabled="!tauriAvailable()"
      @input="$emit('changePetSize', Number(($event.target as HTMLInputElement).value))"
    />
  </div>

  <label class="group-title">桌宠形象</label>
  <div class="pet-model-row">
    <span>当前模型</span>
    <span class="pet-size-val">{{ activePetModelLabel }}</span>
  </div>
  <PetModelPicker
    :models="petModels"
    :active-id="activePetModelId"
    :switching="petModelSwitching"
    @select="onPickPetModel"
  />
  <p v-if="petModelMsg" class="hint">{{ petModelMsg }}</p>
  <p class="hint">
    缺少 YUI 时先执行 <code>pnpm pet:models</code>。YUI 来自 N.E.K.O，仅供本地学习评估，请勿商用分发。
  </p>

  <p class="hint">配置保存在本机；桌宠位置与大小会记住，下次启动恢复。</p>

  <label class="group-title">Sidecar（agent 大脑）</label>
  <div class="sidecar-row">
    <span class="dot" :class="healthInfo?.ok ? 'on' : 'off'"></span>
    <span>{{ healthInfo ? `端口 ${settingsInfo?.sidecar?.port ?? "—"}` : "未连接" }}</span>
    <button v-if="tauriAvailable()" class="btn small" @click="$emit('restart')">重启</button>
  </div>
  <details v-if="state.sidecarLogs.length" class="mt8">
    <summary>最近日志（{{ state.sidecarLogs.length }} 条）</summary>
    <pre class="logs">{{ state.sidecarLogs.join("\n") }}</pre>
  </details>
  <label class="group-title">关于</label>
  <p class="hint">
    Diver · 桌面陪伴 Agent<br />
    框架：DeepSeek Harness（dsh-base）· 传输/记忆/提供商：自研插件 · 壳：Tauri 2
  </p>
</template>

<style scoped>
.group-title {
  display: block;
  font-size: 12px;
  color: #8d89a1;
  letter-spacing: 1px;
  margin-top: 4px;
}
.sidecar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #b9b5cc;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6f6b85;
}
.dot.on {
  background: #59d99a;
  box-shadow: 0 0 6px #59d99a;
}
.dot.off {
  background: #d35d5d;
}
.btn.small {
  padding: 4px 12px;
  font-size: 12px;
  margin-left: auto;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #e8e6f0;
  border-radius: 10px;
  cursor: pointer;
  font-family: inherit;
}
.mt8 {
  margin-top: 8px;
}
.logs {
  background: #141420;
  border-radius: 8px;
  padding: 10px;
  font-size: 11px;
  line-height: 1.5;
  color: #9a96ad;
  max-height: 160px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 4px 0 0;
}
details summary {
  font-size: 12px;
  color: #8d89a1;
  cursor: pointer;
}
.hint {
  font-size: 11px;
  color: #6f6b85;
  margin: 0;
  line-height: 1.7;
}
.pet-size-val {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: #e8e6f0;
  font-size: 12px;
}
.pet-size-row {
  display: flex;
  align-items: center;
  margin: 2px 0 6px;
}
.pet-size-slider {
  width: 100%;
  accent-color: #c06ab3;
}
.pet-model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #b9b5cc;
  margin: 2px 0 8px;
}
/* 开关 */
.switch {
  position: relative;
  display: inline-block;
  width: 34px;
  height: 19px;
  margin-left: auto;
  flex-shrink: 0;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  inset: 0;
  background: rgba(255, 255, 255, 0.14);
  border-radius: 19px;
  transition: background 0.2s;
  cursor: pointer;
}
.slider::before {
  content: "";
  position: absolute;
  width: 15px;
  height: 15px;
  left: 2px;
  top: 2px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}
.switch input:checked + .slider {
  background: linear-gradient(135deg, #ff9d6c, #c06ab3);
}
.switch input:checked + .slider::before {
  transform: translateX(15px);
}
.switch input:disabled + .slider {
  opacity: 0.4;
  cursor: default;
}
</style>
