// PresenceTab 纯展示数据：相位能力矩阵 / 相位提示 / 相对时间格式化。
// 对齐 docs/companion-presence-fsm.md §4 能力矩阵；无 IO、无 Tauri。

/** 当前相位允许的能力（L1 能力矩阵展示）。 */
export const CAPABILITIES: Record<string, { key: string; label: string; on: boolean }[]> = {
  off: [],
  booting: [
    { key: "accept_user_input", label: "接受输入", on: false },
    { key: "idle_motion", label: "待机动作", on: false },
    { key: "react_to_pet", label: "桌宠互动", on: false },
  ],
  passive: [
    { key: "accept_user_input", label: "接受输入", on: true },
    { key: "auto_tts", label: "自动朗读", on: true },
    { key: "memory_dream", label: "记忆整理", on: true },
    { key: "web_explore", label: "网络探索", on: true },
  ],
  observing: [
    { key: "accept_user_input", label: "接受输入", on: true },
    { key: "proactive_inject", label: "主动搭话", on: false },
    { key: "auto_tts", label: "自动朗读", on: true },
    { key: "memory_dream", label: "记忆整理", on: true },
    { key: "web_explore", label: "网络探索", on: true },
  ],
  receptive: [
    { key: "accept_user_input", label: "接受输入", on: true },
    { key: "proactive_inject", label: "主动搭话", on: true },
    { key: "auto_tts", label: "自动朗读", on: true },
    { key: "memory_dream", label: "记忆整理", on: true },
    { key: "web_explore", label: "网络探索", on: true },
  ],
  listening: [
    { key: "accept_user_input", label: "接受输入", on: true },
    { key: "accept_steer", label: "可插话", on: true },
    { key: "auto_tts", label: "自动朗读", on: true },
  ],
  thinking: [
    { key: "accept_user_input", label: "接受输入（插话）", on: true },
    { key: "accept_steer", label: "可插话", on: true },
    { key: "auto_tts", label: "自动朗读", on: false },
  ],
  delivering: [
    { key: "accept_user_input", label: "接受输入", on: true },
    { key: "accept_steer", label: "可插话", on: true },
  ],
  dreaming: [
    { key: "accept_user_input", label: "接受输入（可打断）", on: true },
    { key: "accept_steer", label: "可插话（让路）", on: true },
  ],
  exploring: [
    { key: "accept_user_input", label: "接受输入（可打断）", on: true },
    { key: "accept_steer", label: "可插话（让路）", on: true },
    { key: "web_explore", label: "网络探索", on: true },
  ],
};

export function capsOf(p: string) {
  return CAPABILITIES[p] ?? [];
}

/** 相位中文一句话提示（hero 副行）。 */
export const PHASE_HINTS: Record<string, string> = {
  off: "已关闭，不接受任何对外行为",
  booting: "启动缓冲中，短暂静默后进入观察",
  passive: "Regime 压制：只应答，不主动",
  observing: "在场感知，等待静默升为可搭话",
  receptive: "可主动搭话 / 可跑记忆整理",
  listening: "对话回合：正在听你说",
  thinking: "回合工作中（working）",
  delivering: "TTS / 动作输出中",
  dreaming: "后台记忆巩固（可被打断）",
  exploring: "记忆取词 → 互联网探索（可被打断）",
};

/** L2 记账时间戳 → 相对时间展示。 */
export function fmtAgo(ms: number): string {
  if (!ms) return "—";
  const d = Date.now() - ms;
  if (d < 0) return "刚刚";
  if (d < 60_000) return `${Math.floor(d / 1000)}s 前`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m 前`;
  return `${Math.floor(d / 3_600_000)}h 前`;
}
