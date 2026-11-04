// 设置状态单例（模块级共享：聊天页注入 TTS、设置页编辑同一份，路由切换不丢表单）。

import { computed, reactive, ref } from "vue";
import { getSettings, health } from "../api";
import type { WindowStartupConfig } from "../tauri";
import { getChat } from "./chat";

export interface SettingsState {
  /** 基础 tab 或插件注册的动态 tab id。 */
  activeTab: string;
  saving: boolean;
  /** provider 配置输入（插件声明驱动）：{ [provider]: { [fieldKey]: value } } */
  configInputs: Record<string, Record<string, string>>;
  provider: string;
  model: string;
  /** 卡片区的提供商 id（默认只常驻 deepseek-official；服务端持久化）。 */
  providerCards: string[];
  ttsEnabled: boolean;
  ttsVoice: string;
  sidecarLogs: string[];
  savingMsg: string;
  saveError: string;
  /** 启动时自动打开的窗口 */
  windowStartup: WindowStartupConfig;
  /** 桌宠缩放百分比（50–200） */
  petSizePercent: number;
}

export const state = reactive<SettingsState>({
  activeTab: "models",
  saving: false,
  configInputs: {},
  provider: "deepseek-official",
  model: "",
  providerCards: [],
  ttsEnabled: false,
  ttsVoice: "",
  sidecarLogs: [],
  savingMsg: "",
  saveError: "",
  windowStartup: { autoOpenMain: true, autoOpenPet: true },
  petSizePercent: 100,
});

/** 设置页自身持有的 settingsInfo（与 chat.settingsInfo 同步）。 */
export const settingsInfo = ref<Awaited<ReturnType<typeof getSettings>> | null>(null);
export const healthInfo = ref<Awaited<ReturnType<typeof health>> | null>(null);

// ---------- 派生 ----------
export const providerDecls = computed(() => settingsInfo.value?.providers ?? []);
export const currentProviderDecl = computed(() =>
  providerDecls.value.find((p) => p.provider === state.provider),
);
export const currentProviderModels = computed(() =>
  (settingsInfo.value?.models ?? []).filter((m) => m.provider === state.provider),
);

/** 应用一份 settingsInfo：同步 chat 共享 + 回填 provider 配置输入。 */
export function applySettings(s: NonNullable<typeof settingsInfo.value>) {
  settingsInfo.value = s;
  const chat = getChat();
  if (chat) chat.settingsInfo.value = s;
  state.provider = s.provider;
  state.model = s.model;
  state.providerCards = [...(s.providerCards ?? [])];
  for (const p of s.providers ?? []) {
    state.configInputs[p.provider] ??= {};
    for (const f of p.fields) {
      // secret 不回显；settings 非 secret 回填当前值，便于查看/清空。
      state.configInputs[p.provider][f.key] =
        f.secret || f.store === "credentials" ? "" : (f.value ?? "");
    }
  }
}
