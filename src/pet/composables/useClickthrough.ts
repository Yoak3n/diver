// 点击穿透：默认穿透，命中可交互区则解除（Rust 全局鼠标流驱动）。

import {
  tauriAvailable,
  onTauriEvent,
  startPetMouseStream,
} from "../../tauri";
import { PET_MOUSE_MOVE_EVENT } from "../constants";
import type { PetModelHandle } from "../live2d";

const INTERACTIVE_SELECTOR =
  ".model-hitbox, .speech-bubble, .chat-flow, .model-picker-panel, .question-card, .conn-dot";
const HIT_SLOP = 16;
const WIN_GEOM_TTL_MS = 400;

export function useClickthrough(opts: {
  getPet: () => PetModelHandle | null;
}) {
  let unlistenMouseMove: (() => void) | null = null;
  let clickthroughActive = true;
  let lastMouseScreen: { x: number; y: number } | null = null;
  let winGeomCache: { x: number; y: number; w: number; h: number; at: number } | null = null;

  function getLastMouse() {
    return lastMouseScreen;
  }

  function isInteractiveAt(clientX: number, clientY: number): boolean {
    try {
      const el = document.elementFromPoint(clientX, clientY);
      if (el?.closest?.(INTERACTIVE_SELECTOR)) return true;
      const slop = HIT_SLOP;
      for (const node of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
        const r = (node as HTMLElement).getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (
          clientX >= r.left - slop &&
          clientX <= r.right + slop &&
          clientY >= r.top - slop &&
          clientY <= r.bottom + slop
        ) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async function refreshWinGeom(force = false) {
    if (!tauriAvailable()) return null;
    const now = performance.now();
    if (!force && winGeomCache && now - winGeomCache.at < WIN_GEOM_TTL_MS) return winGeomCache;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
      winGeomCache = { x: pos.x, y: pos.y, w: size.width, h: size.height, at: now };
      return winGeomCache;
    } catch {
      return winGeomCache;
    }
  }

  async function applyClickthroughAt(screenX: number, screenY: number) {
    if (!tauriAvailable()) return;
    try {
      const geom = await refreshWinGeom();
      if (!geom) return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const dpr = window.devicePixelRatio || 1;
      const clientX = (screenX - geom.x) / dpr;
      const clientY = (screenY - geom.y) / dpr;
      const outOfWindow =
        clientX < 0 || clientY < 0 || clientX >= geom.w / dpr || clientY >= geom.h / dpr;
      if (outOfWindow) {
        if (!clickthroughActive) {
          clickthroughActive = true;
          await win.setIgnoreCursorEvents(true);
        }
        return;
      }
      const wantIgnore = !isInteractiveAt(clientX, clientY);
      if (wantIgnore === clickthroughActive) return;
      clickthroughActive = wantIgnore;
      await win.setIgnoreCursorEvents(wantIgnore);
    } catch {
      /* 忽略 */
    }
  }

  async function feedLookAt(screenX: number, screenY: number) {
    const pet = opts.getPet();
    if (!pet || !tauriAvailable()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
      const dpr = window.devicePixelRatio || 1;
      const clientX = (screenX - pos.x) / dpr;
      const clientY = (screenY - pos.y) / dpr;
      if (
        clientX < 0 ||
        clientY < 0 ||
        clientX >= size.width / dpr ||
        clientY >= size.height / dpr
      ) {
        return;
      }
      pet.setLookAt(clientX, clientY);
    } catch {
      /* 忽略 */
    }
  }

  async function startClickthrough() {
    if (!tauriAvailable()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      clickthroughActive = true;
      await getCurrentWindow().setIgnoreCursorEvents(true);
    } catch {
      /* 忽略 */
    }
    try {
      await startPetMouseStream();
      unlistenMouseMove = await onTauriEvent<{ x: number; y: number }>(
        PET_MOUSE_MOVE_EVENT,
        (p) => {
          lastMouseScreen = { x: p.x, y: p.y };
          void applyClickthroughAt(p.x, p.y);
          void feedLookAt(p.x, p.y);
        },
      );
    } catch (err) {
      console.error("[pet] mouse stream unavailable", err);
    }
  }

  function stopClickthrough() {
    unlistenMouseMove?.();
    unlistenMouseMove = null;
    clickthroughActive = true;
  }

  return {
    getLastMouse,
    applyClickthroughAt,
    startClickthrough,
    stopClickthrough,
  };
}
