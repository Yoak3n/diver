// 陪伴存在感状态机（L0 Presence FSM）IPC：相位与调试快照。

import { invoke, tauriAvailable } from "./core";

/** 对外相位 = HSM 叶子名（见 docs/companion-presence-fsm.md）。 */
export type PresencePhase =
  | "off"
  | "booting"
  | "passive"
  | "observing"
  | "receptive"
  | "listening"
  | "thinking"
  | "delivering"
  | "dreaming"
  | "exploring";

/** 正交区 Regime。 */
export type PresenceRegime = "normal" | "dnd" | "quiet_hours" | "focus" | "sleep";

export interface ProactiveSnapshot {
  last_user_chat_at: number;
  last_chat_at: number;
  last_proactive_at: number;
  window_triggers: number;
  quiet_ms: number;
  cooldown_ms: number;
  max_triggers: number;
}

export interface PresenceSnapshot {
  phase: PresencePhase;
  phase_name: string;
  enabled: boolean;
  regime: PresenceRegime | string;
  user_input_active: boolean;
  booted_at: number;
  proactive: ProactiveSnapshot;
}

/** 相位中文标签（展示用）。 */
export const PRESENCE_PHASE_LABELS: Record<PresencePhase, string> = {
  off: "已关闭",
  booting: "启动中",
  passive: "被动应答",
  observing: "观察中",
  receptive: "可搭话",
  listening: "倾听",
  thinking: "思考中",
  delivering: "播报中",
  dreaming: "整理记忆",
  exploring: "探索中",
};

/** Regime 中文标签。 */
export const PRESENCE_REGIME_LABELS: Record<string, string> = {
  normal: "常态",
  dnd: "勿扰",
  quiet_hours: "静默时段",
  focus: "专注",
  sleep: "睡眠",
};

export function presencePhaseLabel(phase: string): string {
  return PRESENCE_PHASE_LABELS[phase as PresencePhase] ?? phase;
}

export function presenceRegimeLabel(regime: string): string {
  return PRESENCE_REGIME_LABELS[regime] ?? regime;
}

/** 当前相位叶子名。非 Tauri 环境返回 null。 */
export async function getPresencePhase(): Promise<PresencePhase | null> {
  if (!tauriAvailable()) return null;
  try {
    return await invoke<PresencePhase>("presence_phase");
  } catch {
    return null;
  }
}

/** 存在感调试快照（相位 + 上下文 + ProactiveSpeak 记账）。 */
export async function getPresenceSnapshot(): Promise<PresenceSnapshot | null> {
  if (!tauriAvailable()) return null;
  try {
    return await invoke<PresenceSnapshot>("presence_snapshot");
  } catch {
    return null;
  }
}
