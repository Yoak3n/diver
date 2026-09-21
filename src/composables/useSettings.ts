// 设置面板状态与逻辑（插件声明驱动的配置、保存、Sidecar 管理）

import { computed, reactive } from "vue";
import { getSettings, saveSettings } from "../api";
import {
  getSidecarStatus,
  getWindowStartupConfig,
  getPetWindowConfig,
  setPetSizePercent,
  listVoices,
  restartSidecar,
  setWindowStartupConfig,
  tauriAvailable,
  type WindowStartupConfig,
} from "../tauri";
import type { useChat } from "./chat";

export interface SettingsState {
  open: boolean;
  activeTab: "models" | "voice" | "mcp" | "plugins" | "shortcuts" | "system";
  saving: boolean;
  /** provider 配置输入（插件声明驱动）：{ [provider]: { [fieldKey]: value } } */
  configInputs: Record<string, Record<string, string>>;
  provider: string;
  model: string;
  ttsEnabled: boolean;
  ttsVoice: string;
  voices: string[];
  sidecarLogs: string[];
  savingMsg: string;
  saveError: string;
  /** 启动时自动打开的窗口 */
  windowStartup: WindowStartupConfig;
  /** 桌宠缩放百分比（50–200） */
  petSizePercent: number;
}

export function useSettings(chat: ReturnType<typeof useChat>) {
  const state = reactive<SettingsState>({
    open: false,
    activeTab: "models",
    saving: false,
    configInputs: {},
    provider: "deepseek-official",
    model: "",
    ttsEnabled: false,
    ttsVoice: "",
    voices: [],
    sidecarLogs: [],
    savingMsg: "",
    saveError: "",
    windowStartup: { autoOpenMain: true, autoOpenPet: true },
    petSizePercent: 100,
  });

  // ---------- 派生 ----------
  const providerDecls = computed(() => chat.settingsInfo.value?.providers ?? []);
  const currentProviderDecl = computed(() =>
    providerDecls.value.find((p) => p.provider === state.provider),
  );
  const currentProviderModels = computed(() =>
    (chat.settingsInfo.value?.models ?? []).filter((m) => m.provider === state.provider),
  );

  // ---------- 打开 ----------
  async function openSettings() {
    state.saveError = "";
      state.savingMsg = "";

      // 先基于已有的 settingsInfo 初始化配置输入，避免面板在 configInputs 尚未就绪时渲染。
      const current = chat.settingsInfo.value;
      if (current) {
        state.provider = current.provider;
        state.model = current.model;
        state.ttsEnabled = current.ttsEnabled;
        state.ttsVoice = current.ttsVoice;
        for (const p of current.providers ?? []) {
          state.configInputs[p.provider] ??= {};
          for (const f of p.fields) state.configInputs[p.provider][f.key] = "";
        }
      }

      state.open = true;
    state.saveError = "";
    state.savingMsg = "";
    try {
      const s = await getSettings();
      chat.settingsInfo.value = s;
      state.provider = s.provider;
      state.model = s.model;
      state.ttsEnabled = s.ttsEnabled;
      state.ttsVoice = s.ttsVoice;
      // 按插件声明初始化配置输入结构
      for (const p of s.providers ?? []) {
        state.configInputs[p.provider] ??= {};
        for (const f of p.fields) state.configInputs[p.provider][f.key] = "";
      }
    } catch {
      /* ignore */
    }
    if (tauriAvailable()) {
      try {
        state.voices = await listVoices();
        if (!state.ttsVoice && state.voices.length > 0) {
          const zh = state.voices.find((v) =>
            /zh|Chinese|Huihui|Yaoyao|Kangkang|Xiaoxiao|Yunxi|Yunyang/i.test(v),
          );
          state.ttsVoice = zh ?? state.voices[0];
        }
      } catch {
        /* ignore */
      }
      try {
        const st = await getSidecarStatus();
        state.sidecarLogs = st.logs;
      } catch {
        /* ignore */
      }
    }
    if (tauriAvailable()) {
      try {
        state.windowStartup = await getWindowStartupConfig();
      } catch {
        /* 读取失败保持默认 */
      }
      try {
        const petCfg = await getPetWindowConfig();
        state.petSizePercent = petCfg.sizePercent;
      } catch {
        /* 读取失败保持默认 */
      }
    }
  }

  /** 切换"启动时打开某窗口"，立即持久化。 */
  async function toggleWindowStartup(key: "autoOpenMain" | "autoOpenPet", value: boolean) {
    state.windowStartup[key] = value;
    if (!tauriAvailable()) return;
    try {
      await setWindowStartupConfig({ ...state.windowStartup });
    } catch {
      /* 保存失败回滚 */
      state.windowStartup[key] = !value;
    }
  }

  /** 设置桌宠缩放百分比（立即应用到桌宠窗口）。 */
  async function changePetSize(percent: number) {
    const next = Math.min(200, Math.max(50, Math.round(percent)));
    const prev = state.petSizePercent;
    state.petSizePercent = next;
    if (!tauriAvailable()) return;
    try {
      const cfg = await setPetSizePercent(next);
      state.petSizePercent = cfg.sizePercent;
    } catch {
      state.petSizePercent = prev;
    }
  }

  // ---------- 保存 ----------
  async function save() {
    state.saving = true;
    state.saveError = "";
    state.savingMsg = "";
    try {
      const body: Record<string, unknown> = {};
      // 插件化配置：收集所有 provider 的非空输入
      const providerConfigs: Record<string, Record<string, string>> = {};
      for (const [p, fields] of Object.entries(state.configInputs)) {
        const nonEmpty: Record<string, string> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v.trim()) nonEmpty[k] = v.trim();
        }
        if (Object.keys(nonEmpty).length > 0) providerConfigs[p] = nonEmpty;
      }
      if (Object.keys(providerConfigs).length > 0) body.providerConfigs = providerConfigs;
      body.provider = state.provider;
      body.model = state.model;
      body.ttsEnabled = state.ttsEnabled;
      body.ttsVoice = state.ttsVoice;
      const res = await saveSettings(body);
      // 清空输入（已写入服务端）
      for (const fields of Object.values(state.configInputs)) {
        for (const k of Object.keys(fields)) fields[k] = "";
      }
      state.savingMsg = "已保存";
      // 刷新状态（configured 标记等）
      try {
        chat.settingsInfo.value = await getSettings();
      } catch {
        /* ignore */
      }
      if (chat.healthInfo.value) {
        chat.healthInfo.value = {
          ...chat.healthInfo.value,
          modelConfigured: res.modelConfigured,
          provider: res.provider,
          model: res.model,
        };
      }
    } catch (err) {
      state.saveError = err instanceof Error ? err.message : String(err);
    } finally {
      state.saving = false;
    }
  }

  // ---------- Sidecar 重启 ----------
  async function doRestartSidecar() {
    if (!tauriAvailable()) return;
    try {
      await restartSidecar();
      await new Promise((r) => setTimeout(r, 1500));
      await chat.reconnect();
      const st = await getSidecarStatus();
      state.sidecarLogs = st.logs;
    } catch {
      /* ignore */
    }
  }

  return {
    state,
    providerDecls,
    currentProviderDecl,
    currentProviderModels,
    openSettings,
    save,
    doRestartSidecar,
    toggleWindowStartup,
    changePetSize,
  };
}
