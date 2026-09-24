// 在线 TTS 设置表单状态与持久化。

import { computed, onMounted, ref, watch, type Ref } from "vue";
import type { SettingsState } from "../../../composables/useSettings";
import {
  getTtsConfig,
  listTtsModels,
  listTtsVoices,
  setTtsConfig,
  tauriAvailable,
} from "../../../tauri";
import type { TtsVoice } from "../../../types";
import { speakMessageText, stopSpeaking } from "../../../tts";

const PROVIDERS = [
  { id: "mimo", label: "MiMo TTS", needsKey: true },
  { id: "minimax", label: "MiniMax", needsKey: true },
  { id: "volcengine", label: "火山引擎 Agent", needsKey: true },
] as const;

export function useTtsSettings(state: Ref<SettingsState>) {
  const ready = ref(false);
  const saving = ref(false);
  const msg = ref("");
  const err = ref("");

  const enabled = ref(false);
  const provider = ref("mimo");
  const voice = ref("冰糖");
  const model = ref("mimo-v2.5-tts");
  const speed = ref(1);
  const apiHost = ref("");
  const resourceId = ref("");
  const styleInstruction = ref("");
  const format = ref("mp3");
  const customVoices = ref<string[]>([]);
  const newCustomVoice = ref("");

  const apiKey = ref("");
  const hasApiKey = ref(false);

  const voices = ref<TtsVoice[]>([]);
  const models = ref<string[]>([]);

  const currentProviderLabel = computed(
    () => PROVIDERS.find((p) => p.id === provider.value)?.label ?? provider.value,
  );
  const isMimo = computed(() => provider.value === "mimo");
  const isMinimax = computed(() => provider.value === "minimax");
  const isVolc = computed(() => provider.value === "volcengine");

  function applyView(v: Awaited<ReturnType<typeof getTtsConfig>>) {
    enabled.value = v.enabled;
    provider.value = v.provider;
    voice.value = v.voice;
    model.value = v.model;
    speed.value = v.speed;
    apiHost.value = v.apiHost;
    resourceId.value = v.resourceId;
    styleInstruction.value = v.styleInstruction;
    format.value = v.format;
    customVoices.value = [...v.customVoices];
    hasApiKey.value = v.hasApiKey;
    apiKey.value = "";
    state.value.ttsEnabled = v.enabled;
    state.value.ttsVoice = v.voice;
  }

  async function refreshVoicesModels() {
    try {
      voices.value = await listTtsVoices(provider.value);
    } catch {
      voices.value = [];
    }
    try {
      models.value = await listTtsModels(provider.value);
    } catch {
      models.value = [];
    }
    if (!voice.value && voices.value.length > 0) {
      voice.value = voices.value[0].id;
    }
    if (models.value.length > 0 && !models.value.includes(model.value)) {
      model.value = models.value[0];
    }
  }

  async function load() {
    if (!tauriAvailable()) return;
    try {
      applyView(await getTtsConfig());
      await refreshVoicesModels();
      ready.value = true;
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function persist() {
    if (!tauriAvailable()) return;
    saving.value = true;
    err.value = "";
    msg.value = "";
    try {
      const view = await setTtsConfig({
        enabled: enabled.value,
        provider: provider.value,
        voice: voice.value,
        model: model.value,
        speed: speed.value,
        apiHost: apiHost.value,
        resourceId: resourceId.value,
        styleInstruction: styleInstruction.value,
        format: format.value,
        customVoices: [...customVoices.value],
        apiKey: apiKey.value.trim(),
      });
      applyView(view);
      msg.value = "已保存";
      await refreshVoicesModels();
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e);
    } finally {
      saving.value = false;
    }
  }

  async function onProviderChange() {
    model.value = "";
    apiHost.value = "";
    await refreshVoicesModels();
    await persist();
  }

  async function preview() {
    err.value = "";
    msg.value = "";
    try {
      stopSpeaking();
      await persist();
      await speakMessageText("你好，很高兴认识你。", voice.value || undefined, undefined, { force: true });
      msg.value = "试听完成";
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e);
    }
  }

  function addCustomVoice() {
    const id = newCustomVoice.value.trim();
    if (!id || customVoices.value.includes(id)) return;
    customVoices.value.push(id);
    newCustomVoice.value = "";
    void persist();
  }

  function removeCustomVoice(id: string) {
    customVoices.value = customVoices.value.filter((v) => v !== id);
    void persist();
  }

  watch(enabled, () => void persist());
  watch(voice, () => {
    state.value.ttsVoice = voice.value;
    void persist();
  });
  watch(model, () => void persist());
  watch(speed, () => void persist());
  watch(format, () => void persist());
  watch(apiHost, () => void persist());
  watch(resourceId, () => void persist());
  watch(styleInstruction, () => void persist());

  onMounted(() => void load());

  return {
    ready,
    saving,
    msg,
    err,
    enabled,
    provider,
    voice,
    model,
    speed,
    apiHost,
    resourceId,
    styleInstruction,
    format,
    customVoices,
    newCustomVoice,
    apiKey,
    hasApiKey,
    voices,
    models,
    PROVIDERS,
    currentProviderLabel,
    isMimo,
    isMinimax,
    isVolc,
    persist,
    onProviderChange,
    preview,
    addCustomVoice,
    removeCustomVoice,
    stopSpeaking,
  };
}
