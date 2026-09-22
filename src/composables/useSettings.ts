// 设置状态与逻辑（插件声明驱动的配置、保存、Sidecar 管理）。
//
// 状态为模块级单例：聊天页注入 TTS、设置页编辑共享同一份，
// 路由切换不丢已填表单。openSettings 只负责拉取/回填，页面切换走 router。

import { computed, reactive, ref } from "vue";
import { getSettings, health, saveSettings } from "../api";
import {
  getSidecarStatus,
  getTtsConfig,
  getWindowStartupConfig,
  getPetWindowConfig,
  onTauriEvent,
  setPetSizePercent,
  restartSidecar,
  setWindowStartupConfig,
  tauriAvailable,
  type WindowStartupConfig,
} from "../tauri";
import type { SidecarStatus } from "../types";
import { getChat } from "./chat";

export type SettingsTab =
  | "models"
  | "voice"
  | "mcp"
  | "plugins"
  | "shortcuts"
  | "schedule"
  | "system";

export const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "models", label: "模型与提供商" },
  { id: "voice", label: "语音" },
  { id: "mcp", label: "MCP 服务" },
  { id: "plugins", label: "插件" },
  { id: "shortcuts", label: "快捷键" },
  { id: "schedule", label: "日程" },
  { id: "system", label: "系统" },
];

export function isSettingsTab(v: string): v is SettingsTab {
  return SETTINGS_TABS.some((t) => t.id === v);
}

export interface SettingsState {
  activeTab: SettingsTab;
  saving: boolean;
  /** provider 配置输入（插件声明驱动）：{ [provider]: { [fieldKey]: value } } */
  configInputs: Record<string, Record<string, string>>;
  provider: string;
  model: string;
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

const state = reactive<SettingsState>({
  activeTab: "models",
  saving: false,
  configInputs: {},
  provider: "deepseek-official",
  model: "",
  ttsEnabled: false,
  ttsVoice: "",
  sidecarLogs: [],
  savingMsg: "",
  saveError: "",
  windowStartup: { autoOpenMain: true, autoOpenPet: true },
  petSizePercent: 100,
});

/** 设置页自身持有的 settingsInfo（与 chat.settingsInfo 同步）。 */
const settingsInfo = ref<Awaited<ReturnType<typeof getSettings>> | null>(null);
const healthInfo = ref<Awaited<ReturnType<typeof health>> | null>(null);

// ---------- 派生 ----------
const providerDecls = computed(() => settingsInfo.value?.providers ?? []);
const currentProviderDecl = computed(() =>
  providerDecls.value.find((p) => p.provider === state.provider),
);
const currentProviderModels = computed(() =>
  (settingsInfo.value?.models ?? []).filter((m) => m.provider === state.provider),
);

function applySettings(s: NonNullable<typeof settingsInfo.value>) {
  settingsInfo.value = s;
  const chat = getChat();
  if (chat) chat.settingsInfo.value = s;
  state.provider = s.provider;
  state.model = s.model;
  for (const p of s.providers ?? []) {
    state.configInputs[p.provider] ??= {};
    for (const f of p.fields) {
      // secret 不回显；settings 非 secret 回填当前值，便于查看/清空。
      state.configInputs[p.provider][f.key] =
        f.secret || f.store === "credentials" ? "" : (f.value ?? "");
    }
  }
}

/** 拉取并回填设置（进入设置页 / 手动刷新 / sidecar 重启后自动调用）。 */
async function openSettings() {
  bindSidecarAutoRefresh();

  // 先基于已有的 settingsInfo 初始化，避免表单闪烁。
  const current = settingsInfo.value ?? getChat()?.settingsInfo.value ?? null;
  if (current) applySettings(current);

  try {
    applySettings(await getSettings());
  } catch {
    /* ignore */
  }
  try {
    healthInfo.value = await health();
    const chat = getChat();
    if (chat && healthInfo.value) chat.healthInfo.value = healthInfo.value;
  } catch {
    /* ignore */
  }
  if (tauriAvailable()) {
    try {
      state.ttsEnabled = (await getTtsConfig()).enabled;
    } catch {
      /* ignore */
    }
    try {
      const st = await getSidecarStatus();
      state.sidecarLogs = st.logs;
    } catch {
      /* ignore */
    }
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

/** sidecar 就绪后自动回填设置（覆盖插件启停重启 / 系统重启，无需手动刷新页面）。 */
let sidecarAutoRefreshBound = false;
let sidecarRefreshTimer: number | null = null;

function bindSidecarAutoRefresh() {
  if (sidecarAutoRefreshBound || !tauriAvailable()) return;
  sidecarAutoRefreshBound = true;
  void onTauriEvent<SidecarStatus>("sidecar://status", (status) => {
    if (status.state !== "running") return;
    if (sidecarRefreshTimer !== null) window.clearTimeout(sidecarRefreshTimer);
    sidecarRefreshTimer = window.setTimeout(() => {
      sidecarRefreshTimer = null;
      void openSettings();
    }, 400);
  });
}

/** 轮询拉取设置直到 sidecar 就绪（重启后旧状态可能仍报 running，不能只看事件）。 */
async function pullSettingsWhenReady(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      applySettings(await getSettings());
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
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
    // 插件化配置：
    // - secret/credentials：空串 = 留空不修改，仅非空时提交
    // - settings 非 secret：始终提交（空串 = 清空、回退适配器默认）
    const providerConfigs: Record<string, Record<string, string>> = {};
    for (const decl of providerDecls.value) {
      const fields = state.configInputs[decl.provider];
      if (!fields) continue;
      const payload: Record<string, string> = {};
      let any = false;
      for (const f of decl.fields) {
        const v = (fields[f.key] ?? "").trim();
        if (f.secret || f.store === "credentials") {
          if (v === "") continue;
          payload[f.key] = v;
          any = true;
        } else {
          payload[f.key] = v;
          any = true;
        }
      }
      if (any) providerConfigs[decl.provider] = payload;
    }
    if (Object.keys(providerConfigs).length > 0) body.providerConfigs = providerConfigs;
    body.provider = state.provider;
    body.model = state.model;
    const res = await saveSettings(body);
    state.savingMsg = "已保存";
    // 刷新状态（configured 标记等），并回填 settings 字段当前值
    try {
      applySettings(await getSettings());
    } catch {
      // 刷新失败时至少清空 secret 输入，避免旧 key 误当作“待写入”
      for (const fields of Object.values(state.configInputs)) {
        for (const k of Object.keys(fields)) fields[k] = "";
      }
    }
    const chat = getChat();
    if (chat?.healthInfo.value) {
      chat.healthInfo.value = {
        ...chat.healthInfo.value,
        modelConfigured: res.modelConfigured,
        provider: res.provider,
        model: res.model,
      };
      healthInfo.value = chat.healthInfo.value;
    } else {
      try {
        healthInfo.value = await health();
      } catch {
        /* ignore */
      }
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
  bindSidecarAutoRefresh();
  state.saveError = "";
  state.savingMsg = "正在重启 sidecar…";
  try {
    await restartSidecar();
    // 旧进程可能短暂仍报 running：轮询 /api/settings 直到新进程就绪并回填，
    // 避免用户必须手动刷新页面才能看到新注册的 provider/模型目录。
    await pullSettingsWhenReady();
    await openSettings();
    const chat = getChat();
    if (chat) await chat.reconnect();
    else {
      try {
        healthInfo.value = await health();
      } catch {
        /* ignore */
      }
    }
    const st = await getSidecarStatus();
    state.sidecarLogs = st.logs;
    state.savingMsg = "sidecar 已重启成功，设置已刷新";
  } catch (err) {
    state.savingMsg = "";
    state.saveError =
      err instanceof Error ? `重启失败: ${err.message}` : `重启失败: ${String(err)}`;
  }
}

export function useSettings() {
  return {
    state,
    settingsInfo,
    healthInfo,
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
