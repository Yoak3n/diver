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
    display?: {
      id?: number | string;
      width?: number;
      height?: number;
      x?: number;
      y?: number;
      primary?: boolean;
    };
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

/**
 * 窗口（物理坐标 x,y,w,h）归属哪块屏——与壳层 clamp（`move_by_delta`）同规则：
 * 中心点所在屏优先；中心落在屏间间隙时取距离最近的屏。
 *
 * 跨屏事件必须用这条规则而不是左上角采样点：桌宠被拖到屏幕边缘时，松手后
 * clamp 会按中心点把它夹回「中心所在屏」——事件的 to 报的就是这块屏，
 * 否则会出现「嘴上说到了主屏、身子被夹回副屏」的口是心非。
 */
export function monitorIndexForWindow(
  monitors: MonitorInfo[],
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  const cx = x + w / 2;
  const cy = y + h / 2;
  let nearest = -1;
  let nearestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < monitors.length; i++) {
    const m = monitors[i];
    const left = m.x;
    const top = m.y;
    const right = m.x + m.width;
    const bottom = m.y + m.height;
    if (cx >= left && cx < right && cy >= top && cy < bottom) {
      return i;
    }
    const dx = cx < left ? left - cx : cx >= right ? cx - right + 1 : 0;
    const dy = cy < top ? top - cy : cy >= bottom ? cy - bottom + 1 : 0;
    const dist = dx * dx + dy * dy;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = i;
    }
  }
  return nearest;
}

/** 主屏：优先用壳端给的 `primary` 标记；缺省退回「包含 (0,0)」近似。 */
export function primaryMonitorIndex(monitors: MonitorInfo[]): number {
  const flagged = monitors.findIndex((m) => m.primary === true);
  if (flagged >= 0) return flagged;
  const hit = monitorIndexAt(monitors, 0, 0);
  return hit >= 0 ? hit : 0;
}

export interface PetInteractionTracker {
  /** 拖动会话开始（beginDrag / 系统拖动生效）。 */
  beginDragSession(): void;
  /** 窗口 Moved：更新所在屏，跨屏时上报（同一会话只报一次）。
   * `x`/`y` 为窗口左上角物理坐标（原始 Moved 值，勿加偏移）；
   * 归屏规则与壳层 clamp 一致（中心点所在/最近屏）。 */
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
  let winSize: { w: number; h: number } | null = null;

  function clearLongHoldTimer() {
    if (longHoldTimer !== null) {
      window.clearTimeout(longHoldTimer);
      longHoldTimer = null;
    }
  }

  /** 拉取窗口物理尺寸（中心点判屏依赖；拖动会话内尺寸不变）。 */
  function refreshWinSize() {
    if (winSize) return;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const size = await getCurrentWindow().outerSize();
        winSize = { w: size.width, h: size.height };
      } catch {
        /* 保持 null，退回采样点规则 */
      }
    })();
  }

  async function displayContext(index: number) {
    const monitors = await getMonitors();
    const m = monitors[index];
    if (!m) return undefined;
    const primary = m.primary ?? (primaryMonitorIndex(monitors) === index);
    return {
      display: {
        // canonical 编号：与截屏工具 list_displays 的 display index 同源，
        // 事件里说「屏幕 N」即工具的 display N（禁止用枚举原序）。
        id: m.index ?? index,
        width: m.width,
        height: m.height,
        x: m.x,
        y: m.y,
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
        // 以窗口当前位置初始化所在屏（进入拖动时），规则与壳层 clamp 一致。
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
          winSize = { w: size.width, h: size.height };
          // outerPosition/outerSize 均为物理像素；monitor 坐标亦为物理
          lastScreen = monitorIndexForWindow(monitors, pos.x, pos.y, size.width, size.height);
        } catch {
          lastScreen = -1;
          refreshWinSize();
        }
      });
    },
    noteMoved(x: number, y: number) {
      if (!dragging || disposed) return;
      if (!winSize) refreshWinSize();
      // 拖动仍在进行：重置长拖计时器的语义是「持续按住」，
      // 但有意阈值按「按下至今」算，不因移动而重置。
      void getMonitors().then((monitors) => {
        // 归屏用中心点规则（与 clamp 同源）；尺寸未取到时退回左上角+40 采样。
        const idx = winSize
          ? monitorIndexForWindow(monitors, x, y, winSize.w, winSize.h)
          : monitorIndexAt(monitors, x + 40, y + 40);
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
