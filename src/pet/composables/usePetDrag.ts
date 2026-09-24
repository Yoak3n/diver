// 长按拖动 / 点按互动 / 蓄力环。

import { ref } from "vue";
import {
  tauriAvailable,
  movePetWindow,
  cancelPetMoveAnimation,
  setPetDragging,
} from "../../tauri";
import {
  createPetInteractionTracker,
  DEFAULT_LONG_HOLD_MS,
  type PetInteractionTracker,
} from "../interaction";

const LONG_PRESS_MS = 350;
const CHARGE_UI_DELAY_MS = 150;
const CHARGE_MOVE_TOLERANCE = 12;
const CLICK_MOVE_TOLERANCE = 28;
const DRAG_IDLE_MS = 1500;
const DRAG_SESSION_MS = 1500;
const CLICK_ZONE_COOLDOWN_MS = 550;

export const PET_DRAG_LONG_PRESS_MS = LONG_PRESS_MS;

export function usePetDrag(opts: {
  getPet: () => { react: (e: string, o?: { force?: boolean; zone?: "head" | "body" | "auto" }) => void; getHitbox: () => { left: number; top: number; width: number; height: number } | null } | null;
  inPanelArea: (target: EventTarget | null) => boolean;
  onDragIdle: () => void;
}) {
  const dragState = ref<"idle" | "arming" | "dragging">("idle");
  const chargePos = ref({ x: 0, y: 0 });
  const chargeUiVisible = ref(false);

  let chargeOrigin: { x: number; y: number } | null = null;
  let pressTimer: number | null = null;
  let chargeUiTimer: number | null = null;
  let longPressDragging = false;
  let petDragSession = false;
  let dragIdleTimer: number | null = null;
  let unlistenPetMoved: (() => void) | null = null;
  let clickCandidate = false;
  let suppressClickReaction = false;
  const lastClickReactAt: Record<"head" | "body", number> = { head: 0, body: 0 };
  const interactionTracker: PetInteractionTracker = createPetInteractionTracker();

  function clearPressTimer() {
    if (pressTimer !== null) {
      window.clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function clearChargeUiTimer() {
    if (chargeUiTimer !== null) {
      window.clearTimeout(chargeUiTimer);
      chargeUiTimer = null;
    }
    chargeUiVisible.value = false;
  }

  function clearDragIdleTimer() {
    if (dragIdleTimer !== null) {
      window.clearTimeout(dragIdleTimer);
      dragIdleTimer = null;
    }
  }

  function endDragVisualState() {
    interactionTracker.endDragSession();
    petDragSession = false;
    longPressDragging = false;
    if (dragState.value !== "idle") {
      dragState.value = "idle";
    }
  }

  function armDragIdleRecovery() {
    clearDragIdleTimer();
    dragIdleTimer = window.setTimeout(() => {
      dragIdleTimer = null;
      endDragVisualState();
      void setPetDragging(false);
      void movePetWindow(0, 0);
      opts.onDragIdle();
    }, DRAG_IDLE_MS);
  }

  function armDragSessionTimeout() {
    clearDragIdleTimer();
    dragIdleTimer = window.setTimeout(() => {
      dragIdleTimer = null;
      endDragVisualState();
      void setPetDragging(false);
      opts.onDragIdle();
    }, DRAG_SESSION_MS);
  }

  async function beginDrag() {
    if (!tauriAvailable()) return;
    try {
      cancelPetMoveAnimation();
      void setPetDragging(true);
      clearDragIdleTimer();
      petDragSession = true;
      longPressDragging = true;
      dragState.value = "dragging";
      interactionTracker.beginDragSession();
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().startDragging();
      armDragSessionTimeout();
    } catch {
      endDragVisualState();
      void setPetDragging(false);
      clearDragIdleTimer();
    }
  }

  async function bindPetMovedListener() {
    if (!tauriAvailable() || unlistenPetMoved) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const unlisten = await getCurrentWindow().onMoved((pos) => {
        if (!petDragSession && !longPressDragging) return;
        petDragSession = true;
        if (dragState.value !== "dragging") {
          dragState.value = "dragging";
        }
        const p = pos as unknown as { x?: number; y?: number } | undefined;
        if (p && typeof p.x === "number" && typeof p.y === "number") {
          interactionTracker.noteMoved(p.x + 40, p.y + 40);
        } else {
          void getCurrentWindow()
            .outerPosition()
            .then((wp) => interactionTracker.noteMoved(wp.x + 40, wp.y + 40))
            .catch(() => {});
        }
        armDragIdleRecovery();
      });
      unlistenPetMoved = unlisten;
    } catch {
      /* 忽略 */
    }
  }

  function resetPointerSession() {
    clearPressTimer();
    clearChargeUiTimer();
    chargeOrigin = null;
    clickCandidate = false;
    if (dragState.value === "arming") dragState.value = "idle";
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (opts.inPanelArea(e.target)) return;
    longPressDragging = false;
    suppressClickReaction = false;
    clickCandidate = true;
    chargeOrigin = { x: e.clientX, y: e.clientY };
    chargePos.value = { x: e.clientX, y: e.clientY };
    dragState.value = "arming";
    clearChargeUiTimer();
    chargeUiTimer = window.setTimeout(() => {
      chargeUiTimer = null;
      if (dragState.value === "arming" && chargeOrigin && clickCandidate) {
        chargeUiVisible.value = true;
      }
    }, CHARGE_UI_DELAY_MS);
    clearPressTimer();
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      if (!clickCandidate) return;
      longPressDragging = true;
      suppressClickReaction = true;
      chargeOrigin = null;
      chargeUiVisible.value = false;
      dragState.value = "dragging";
      void beginDrag();
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e: PointerEvent) {
    if (dragState.value !== "arming" || !chargeOrigin) return;
    const dx = e.clientX - chargeOrigin.x;
    const dy = e.clientY - chargeOrigin.y;
    const dist2 = dx * dx + dy * dy;
    if (dist2 > CLICK_MOVE_TOLERANCE * CLICK_MOVE_TOLERANCE) {
      clearPressTimer();
      clearChargeUiTimer();
      chargeOrigin = null;
      clickCandidate = false;
      suppressClickReaction = true;
      dragState.value = "idle";
      return;
    }
    if (dist2 > CHARGE_MOVE_TOLERANCE * CHARGE_MOVE_TOLERANCE) {
      clearPressTimer();
      clearChargeUiTimer();
      chargeOrigin = null;
      clickCandidate = true;
      dragState.value = "idle";
    }
  }

  function hitZoneAt(_clientX: number, clientY: number): "head" | "body" {
    const box = opts.getPet()?.getHitbox();
    if (!box) return "body";
    const relY = (clientY - box.top) / Math.max(1, box.height);
    return relY <= 0.35 ? "head" : "body";
  }

  function onPointerUp(e: PointerEvent) {
    clearPressTimer();
    clearChargeUiTimer();
    chargeOrigin = null;
    const wasLongDrag = longPressDragging;
    longPressDragging = false;
    dragState.value = "idle";
    if (wasLongDrag) {
      clickCandidate = false;
      return;
    }
    const pet = opts.getPet();
    if (!suppressClickReaction && clickCandidate && e.button === 0 && !opts.inPanelArea(e.target) && pet) {
      const zone = hitZoneAt(e.clientX, e.clientY);
      const now = performance.now();
      const last = lastClickReactAt[zone] || 0;
      if (now - last < CLICK_ZONE_COOLDOWN_MS) {
        clickCandidate = false;
        suppressClickReaction = false;
        return;
      }
      lastClickReactAt[zone] = now;
      console.log("[pet] click zone =", zone);
      pet.react("neutral", { force: true, zone });
    }
    clickCandidate = false;
    suppressClickReaction = false;
  }

  function onPointerCancel() {
    resetPointerSession();
    clickCandidate = false;
    suppressClickReaction = true;
    longPressDragging = false;
    dragState.value = "idle";
  }

  async function initInteractionHold() {
    try {
      const { getSettings } = await import("../../api");
      const s = await getSettings();
      if (s.petInteraction?.longHoldMs) {
        interactionTracker.setLongHoldMs(s.petInteraction.longHoldMs);
      }
    } catch {
      interactionTracker.setLongHoldMs(DEFAULT_LONG_HOLD_MS);
    }
  }

  function dispose() {
    petDragSession = false;
    clearDragIdleTimer();
    void setPetDragging(false);
    interactionTracker.dispose();
    unlistenPetMoved?.();
    unlistenPetMoved = null;
  }

  return {
    dragState,
    chargePos,
    chargeUiVisible,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    bindPetMovedListener,
    initInteractionHold,
    dispose,
  };
}
