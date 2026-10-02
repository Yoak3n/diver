<script setup lang="ts">
// 实例音色档案面板：跟随全局 / 整组钉定（提供商 + 模型 + 声线 + 语速 + 风格指令）。
// 整组语义：自定义即五项全量钉定，避免「换提供商不换模型」的跨家错配。
import { onMounted, ref, watch } from "vue";
import type { InstanceMeta, InstanceTtsProfile } from "../../../tauri";
import { getTtsConfig, listTtsModels, listTtsVoices } from "../../../ipc/tts";
import type { TtsVoice } from "../../../types";
import { PROVIDERS } from "../composables/useTtsSettings";

const props = defineProps<{ inst: InstanceMeta }>();
const emit = defineEmits<{ save: [tts: InstanceTtsProfile | null] }>();

const custom = ref(!!props.inst.tts);
const provider = ref(props.inst.tts?.provider ?? "mimo");
const model = ref(props.inst.tts?.model ?? "");
const voice = ref(props.inst.tts?.voice ?? "");
const speed = ref(props.inst.tts?.speed ?? 1);
const styleInstruction = ref(props.inst.tts?.styleInstruction ?? "");

const voices = ref<TtsVoice[]>([]);
const models = ref<string[]>([]);
/** 该提供商是否已配置 API Key（Key 按提供商分槽保存于全局语音设置）。 */
const hasKey = ref(true);

interface GlobalTtsView {
  provider: string;
  model: string;
  voice: string;
  speed: number;
  styleInstruction: string;
  providerCredentials?: { provider: string; hasApiKey: boolean }[];
}

async function refreshOptions(): Promise<void> {
  try {
    voices.value = await listTtsVoices(provider.value);
    models.value = await listTtsModels(provider.value);
  } catch {
    voices.value = [];
    models.value = [];
  }
  try {
    const cfg = (await getTtsConfig()) as GlobalTtsView;
    hasKey.value =
      cfg.providerCredentials?.find((c) => c.provider === provider.value)?.hasApiKey ?? true;
  } catch {
    hasKey.value = true;
  }
}

onMounted(async () => {
  // 跟随全局切自定义的预填：取全局当前配置当起点。
  if (!props.inst.tts) {
    try {
      const cfg = (await getTtsConfig()) as GlobalTtsView;
      provider.value = cfg.provider;
      model.value = cfg.model;
      voice.value = cfg.voice;
      speed.value = cfg.speed;
      styleInstruction.value = cfg.styleInstruction;
    } catch {
      /* 拿不到就用表单缺省 */
    }
  }
  await refreshOptions();
});

watch(provider, async () => {
  // 换提供商：模型/声线重选（缺省值跨家不可用）。
  model.value = "";
  voice.value = "";
  await refreshOptions();
});

function save(): void {
  if (!custom.value) {
    emit("save", null);
    return;
  }
  emit("save", {
    provider: provider.value,
    model: model.value || (models.value[0] ?? ""),
    voice: voice.value || (voices.value[0]?.id ?? ""),
    speed: speed.value,
    styleInstruction: styleInstruction.value.trim(),
  });
}
</script>

<template>
  <div class="tts-panel">
    <label class="follow">
      <input v-model="custom" type="checkbox" />
      自定义音色（不勾 = 跟随全局语音设置）
    </label>
    <div v-if="custom" class="fields">
      <label>
        提供商
        <select v-model="provider">
          <option v-for="p in PROVIDERS" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </label>
      <label>
        模型
        <!-- 可输可选：清单只是建议，清单滞后也能填（如火山新模型）。 -->
        <input
          v-model="model"
          type="text"
          :list="`tts-models-${inst.id}`"
          placeholder="如 seed-tts-2.0"
        />
        <datalist :id="`tts-models-${inst.id}`">
          <option v-for="m in models" :key="m" :value="m" />
        </datalist>
      </label>
      <label>
        声线
        <select v-model="voice">
          <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}</option>
        </select>
      </label>
      <label>
        语速
        <input v-model.number="speed" type="number" min="0.5" max="2" step="0.05" />
      </label>
      <label>
        风格指令
        <input v-model="styleInstruction" type="text" placeholder="可空" />
      </label>
      <p v-if="!hasKey" class="warn">
        该提供商还没配置 API Key：请到「语音」页切到它填入 Key（Key 按提供商分别保存）。
      </p>
      <button class="btn small" @click="save">保存音色</button>
    </div>
    <button v-else class="btn small" @click="save">恢复跟随全局</button>
  </div>
</template>

<style scoped>
.tts-panel {
  flex-basis: 100%;
  width: 100%;
  box-sizing: border-box;
  margin-top: 8px;
  padding: 8px 10px;
  border-top: 1px dashed var(--rule);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.follow {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--ink-muted);
}
.fields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.fields label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--ink-muted);
}
.fields select,
.fields input[type="number"],
.fields input[type="text"] {
  background: var(--paper-sunken);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  color: var(--ink);
  font-size: 11px;
  padding: 4px 6px;
  font-family: inherit;
  max-width: 128px;
}
.warn {
  flex-basis: 100%;
  margin: 0;
  font-size: 11px;
  color: var(--ink-muted);
}
</style>
