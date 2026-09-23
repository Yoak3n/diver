// 桌宠互动事件识别（前端发起）：把拖动等手势收成离散语义事件并 invoke 进壳。
//
// 控制面在壳 CompanionPresence：白名单/组文案/闲时裁决/ inject 均在 Rust。
// 坐标流 / 普通点按 / 同屏短拖 一律不上报。

import { listMonitors, type MonitorInfo } from "../tauri";

export type PetInteractionEventType =
  | "pet.drag.screen_changed"
  | "pet.drag.long_hold";

export interface PetInteractionLocalConfig {
  /** 长拖未松手的有意阈值（ms），与设置 petInteraction.longHoldMs 同步。 */
  longHoldMs: number;
}

export const DEFAULT_LONG_HOLD_MS = 3000;

export interface PetGestureEventPayload {
  type: string;
  ts?: number;
  source?: string;
  payload?: Record<string, unknown>;
  context?: {
    display?: { id?: number | string; width?: number; height?: number; primary?: boolean };
    apps?: string[];
  };
}

/** 手势上行：invoke 壳 `pet_gesture_event`（唯一主动开口入口）。 */
export async function sendPetGesture(event: PetGestureEventPayload): Promise<{
  accepted: boolean;
  reason?: string;
  messageId?: string;
  triggered?: boolean;
}> {
  const { tauriAvailable } = await import("../tauri");
  if (!tauriAvailable()) {
    return { accepted: false, reason: "no_tauri" };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("pet_gesture_event", {
    event: { source: "pet", ts: Date.now(), ...event },
  });
}

/** 点 (x,y) 落在哪块显示器（物理坐标）；找不到返回 -1。 */
export function monitorIndexAt(
  monitors: MonitorInfo[],
  x: number,
  y: number,
): number {
  for (let i = 0; i < monitors.length; i++) {
    const m = monitors[i];
    if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) {
      return i;
    }
  }
  return -1;
}

/** 主屏近似：包含 (0,0) 的显示器；否则取第一块。 */
export function primaryMonitorIndex(monitors: MonitorInfo[]): number {
  const hit = monitorIndexAt(monitors, 0, 0);
  return hit >= 0 ? hit : 0;
}

export interface PetInteractionTracker {
  /** 拖动会话开始（beginDrag / 系统拖动生效）。 */
  beginDragSession(): void;
  /** 窗口 Moved：更新所在屏，跨屏时上报（同一会话只报一次）。 */
  noteMoved(x: number, y: number): void;
  /** 拖动结束（软限位/超时）。 */
  endDragSession(): void;
  /** 点按连击（可选）。 */
  noteTap(): void;
  setLongHoldMs(ms: number): void;
  dispose(): void;
}

export function createPetInteractionTracker(
  getMonitors: () => Promise<MonitorInfo[]> = listMonitors,
): PetInteractionTracker {
  let longHoldMs = DEFAULT_LONG_HOLD_MS;
  let dragging = false;
  let longHoldTimer: number | null = null;
  let longHoldFired = false;
  let screenChangedFired = false;
  let lastScreen = -1;
  let dragStartedAt = 0;
  let disposed = false;

  function clearLongHoldTimer() {
    if (longHoldTimer !== null) {
      window.clearTimeout(longHoldTimer);
      longHoldTimer = null;
    }
  }

  async function displayContext(index: number) {
    const monitors = await getMonitors();
    const m = monitors[index];
    if (!m) return undefined;
    const primary = primaryMonitorIndex(monitors) === index;
    return {
      display: {
        id: index,
        width: m.width,
        height: m.height,
        primary,
      },
    };
  }

  async function emitScreenChanged(from: number, to: number) {
    if (disposed || screenChangedFired) return;
    screenChangedFired = true;
    const context = await displayContext(to);
    try {
      await sendPetGesture({
        type: "pet.drag.screen_changed",
        payload: { fromScreen: from, toScreen: to, dragging: true },
        context,
      });
    } catch {
      /* 上行失败不影响拖动 */
    }
  }

  async function emitLongHold(holdMs: number) {
    if (disposed || longHoldFired || !dragging) return;
    longHoldFired = true;
    const context = lastScreen >= 0 ? await displayContext(lastScreen) : undefined;
    try {
      await sendPetGesture({
        type: "pet.drag.long_hold",
        payload: { holdMs, dragging: true },
        context,
      });
    } catch {
      /* ignore */
    }
  }

  return {
    beginDragSession() {
      dragging = true;
      longHoldFired = false;
      screenChangedFired = false;
      dragStartedAt = Date.now();
      clearLongHoldTimer();
      longHoldTimer = window.setTimeout(() => {
        longHoldTimer = null;
        void emitLongHold(Date.now() - dragStartedAt);
      }, longHoldMs);
      void getMonitors().then(async (monitors) => {
        // 以窗口当前位置初始化所在屏（进入拖动时）
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const pos = await getCurrentWindow().outerPosition();
          // outerPosition 是物理像素；monitor 坐标亦为物理
          lastScreen = monitorIndexAt(monitors, pos.x + 40, pos.y + 40);
        } catch {
          lastScreen = -1;
        }
      });
    },
    noteMoved(x: number, y: number) {
      if (!dragging || disposed) return;
      // 拖动仍在进行：重置长拖计时器的语义是「持续按住」，
      // 但有意阈值按「按下至今」算，不因移动而重置。
      void getMonitors().then((monitors) => {
        const idx = monitorIndexAt(monitors, x, y);
        if (idx < 0 || lastScreen < 0) {
          if (idx >= 0) lastScreen = idx;
          return;
        }
        if (idx !== lastScreen) {
          const from = lastScreen;
          lastScreen = idx;
          void emitScreenChanged(from, idx);
        }
      });
    },
    endDragSession() {
      clearLongHoldTimer();
      dragging = false;
    },
    noteTap() {
      /* V2: pet.tap.burst — 首版不上报 */
    },
    setLongHoldMs(ms: number) {
      longHoldMs = Math.max(500, ms);
    },
    dispose() {
      disposed = true;
      clearLongHoldTimer();
      dragging = false;
    },
  };
}
