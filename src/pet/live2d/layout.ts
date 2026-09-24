// 布局 / 面板让位 / 平滑过渡（scale + anchorX 双标量补间）。

import * as PIXI from "pixi.js";
import type { CharBounds } from "./bounds";
import { updateHitbox } from "./hitbox";

/** easeInOutCubic：0→1 缓入缓出（用于位移，起止都平滑） */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
/** easeOutBack：先快后慢，收尾带轻微回弹过冲（用于缩放，值会短暂超过 1） */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** 面板宽度（与 PetApp.vue 的 .bubble-area width 保持一致）。 */
const PANEL_WIDTH = 383;
/** 让位时模型相对常态的缩放比例。 */
const RETREAT_SCALE_RATIO = 0.87;
const ANIM_DURATION_MS = 520;

export type LayoutDeps = {
  model: { x: number; y: number; scale: { set: (v: number) => void } };
  app: PIXI.Application;
  hitboxEl: HTMLDivElement;
  bounds: CharBounds;
  baseScale: number;
  initAnchorX?: number;
};

export function createLayoutController(deps: LayoutDeps) {
  const { model, app, hitboxEl, bounds } = deps;
  const { charWidth, charHeight, charCenterOffsetX, charBottomOffset } = bounds;

  let anchorXRatio = deps.initAnchorX ?? 0.5;
  let baseAnchorXRatio = anchorXRatio;
  let panelSideRef: "left" | "right" = "right";
  let retreating = false;

  let currentScale = deps.baseScale;
  let targetScale = deps.baseScale;
  let currentAnchorX = anchorXRatio;
  let targetAnchorX = anchorXRatio;
  let animTimer: number | null = null;
  let animFromScale = deps.baseScale;
  let animFromAnchorX = 0.5;
  let animStart = 0;
  let disposed = false;

  function retreatMaxCharWidth(): number {
    const margin = 24;
    return app.screen.width - PANEL_WIDTH - margin;
  }

  function retreatTargetCenterX(scale: number): number {
    const margin = 24;
    const charScreenW = scale * charWidth;
    const side = panelSideRef === "left" ? "left" : "right";
    if (side === "right") {
      const panelLeft = app.screen.width - PANEL_WIDTH;
      return panelLeft - margin - charScreenW / 2;
    }
    const panelRight = PANEL_WIDTH;
    return panelRight + margin + charScreenW / 2;
  }

  function computeTargets() {
    if (retreating) {
      const maxScale = retreatMaxCharWidth() / charWidth;
      targetScale = Math.min(deps.baseScale * RETREAT_SCALE_RATIO, maxScale);
      targetAnchorX = retreatTargetCenterX(targetScale) / app.screen.width;
    } else {
      targetScale = deps.baseScale;
      targetAnchorX = baseAnchorXRatio;
    }
  }

  function applyLayout() {
    model.x = app.screen.width * currentAnchorX - charCenterOffsetX * currentScale;
    model.y = app.screen.height + charBottomOffset * currentScale;
    updateHitbox(hitboxEl, {
      screenWidth: app.screen.width,
      screenHeight: app.screen.height,
      currentScale,
      currentAnchorX,
      charWidth,
      charHeight,
    });
  }

  function animateStep() {
    const t = Math.min(1, Math.max(0, (performance.now() - animStart) / ANIM_DURATION_MS));
    const eMove = easeInOutCubic(t);
    const tScale = t < 0.15 ? 0 : (t - 0.15) / 0.85;
    const eScale = easeOutBack(Math.min(1, tScale));
    currentScale = animFromScale + (targetScale - animFromScale) * eScale;
    currentAnchorX = animFromAnchorX + (targetAnchorX - animFromAnchorX) * eMove;
    model.scale.set(currentScale);
    applyLayout();
    if (t >= 1) {
      PIXI.Ticker.shared.remove(animTick);
      animTimer = null;
    }
  }
  const animTick = () => animateStep();

  function setRetreat(retreat: boolean, panelSide?: "left" | "right") {
    const next = retreat === true;
    const sideChanged = panelSide !== undefined && panelSide !== panelSideRef;
    if (panelSide) panelSideRef = panelSide;
    if (next === retreating && !sideChanged) return;
    retreating = next;
    computeTargets();
    animFromScale = currentScale;
    animFromAnchorX = currentAnchorX;
    animStart = performance.now();
    if (animTimer === null) {
      PIXI.Ticker.shared.add(animTick);
      animTimer = 1;
    }
    applyLayout();
  }

  function setAnchorX(ratio: number) {
    const clamped = Math.min(1, Math.max(0, Number(ratio) || 0));
    if (clamped === anchorXRatio) return;
    anchorXRatio = clamped;
    if (!retreating) {
      baseAnchorXRatio = clamped;
      currentAnchorX = clamped;
      applyLayout();
    }
  }

  function syncResize(container: HTMLElement) {
    const w = container.clientWidth;
    const h = container.clientHeight;
    try {
      if (w > 0 && h > 0 && (w !== app.screen.width || h !== app.screen.height)) {
        app.renderer.resize(w, h);
      }
    } catch (err) {
      console.error("[pet] renderer.resize 失败:", err);
    }
    applyLayout();
  }

  function destroy() {
    if (animTimer !== null) {
      PIXI.Ticker.shared.remove(animTick);
      animTimer = null;
    }
    disposed = true;
  }

  void disposed;

  return {
    applyLayout,
    setRetreat,
    setAnchorX,
    syncResize,
    computeTargets,
    destroy,
    animTick,
  };
}
