// 设置动作：拉取/回填、保存、sidecar 重启、窗口/桌宠设置（传输 IO）。

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
} from "../tauri";
import type { SidecarStatus } from "../types";
import { getChat } from "./chat";
import {
  applySettings,
  healthInfo,
  providerDecls,
  settingsInfo,
  state,
} from "./settings-state";

/**
 * 喂共享 TTS 状态（自动朗读读 `state.ttsEnabled/ttsVoice`）。
 * 启动时必须喂一次：否则重启后恒 false，自动朗读全哑，直到打开一次设置页。
 */
export async function hydrateTtsState(): Promise<void> {
  if (!tauriAvailable()) return;
  try {
    const cfg = await getTtsConfig();
    state.ttsEnabled = cfg.enabled;
    state.ttsVoice = cfg.voice ?? "";
  } catch {
    /* 读取失败保持默认 */
  }
}

/** 拉取并回填设置（进入设置页 / 手动刷新 / sidecar 重启后自动调用）。 */
export async function openSettings() {
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
    await hydrateTtsState();
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
export async function toggleWindowStartup(key: "autoOpenMain" | "autoOpenPet", value: boolean) {
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
export async function changePetSize(percent: number) {
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
export async function save() {
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
export async function doRestartSidecar() {
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
