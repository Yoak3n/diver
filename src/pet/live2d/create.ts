// 在容器内创建 Live2D 模型（底部锚定、可水平偏置）。
// 装配：moc 校验 → 加载 → 包围盒 → 布局/让位 → 动作/表情/视线/口型。

import { Live2DModel } from "pixi-live2d-display/cubism4";
import * as PIXI from "pixi.js";
import { assertMocSupported, enrichLoadError } from "./moc";
import { computeCharBounds } from "./bounds";
import { createHitboxEl, readHitbox } from "./hitbox";
import { createLayoutController } from "./layout";
import { createMotionController } from "./motion";
import { createExpressionController } from "./expression";
import { createLookController } from "./look";
import { createMouthController } from "./mouth";
import { createReact } from "./react";
import type { GroupAliases, PetModelHandle } from "./types";

// 关键：pixi-live2d-display 的 autoUpdate 通过 window.PIXI.Ticker.shared 注册渲染驱动。
// ESM 环境下 PIXI 不会挂到全局，必须手动挂载，否则模型永远不会 update。
(window as unknown as { PIXI?: unknown }).PIXI = PIXI;

const DEFAULT_MODEL_URL = "/pet/models/Hiyori/Hiyori.model3.json";

/**
 * 在容器内创建 Live2D 模型（底部锚定、可水平偏置）。
 * @param container 模型容器
 * @param options
 *   - heightRatio: 模型高度占窗口高度的比例（如 0.7 = 占 70%）。
 *   - anchorXRatio: 模型水平中心占容器宽度的比例，默认 0.5（居中）。
 */
export async function createPetModel(
  container: HTMLElement,
  options: {
    heightRatio?: number;
    anchorXRatio?: number;
    modelUrl?: string;
    groupAliases?: GroupAliases;
  } = {},
): Promise<PetModelHandle> {
  const heightRatio = options.heightRatio ?? 0.7;
  const initAnchorX = options.anchorXRatio ?? 0.5;
  const modelUrl = options.modelUrl ?? DEFAULT_MODEL_URL;
  const modelBase = modelUrl.replace(/[^/]*$/, "");
  const groupAliases = options.groupAliases ?? {};

  if (!container) {
    throw new Error("createPetModel: container 为空（挂载时机过早或已卸载）");
  }

  const app = new PIXI.Application({
    backgroundAlpha: 0,
    resizeTo: container,
    antialias: true,
    autoStart: true,
  });
  const canvas = app.view as HTMLCanvasElement;
  canvas.style.pointerEvents = "none";
  container.appendChild(canvas);

  const hitboxEl = createHitboxEl(container);

  // 注意：不能用 autoInteract —— pixi-live2d-display 0.4 依赖 renderer.plugins.interaction
  // （pixi 6 API），pixi 7.4 中会抛 "manager.on is not a function"。
  await assertMocSupported(modelUrl);
  let model: Live2DModel;
  try {
    model = await Live2DModel.from(modelUrl, { autoInteract: false });
  } catch (err) {
    throw enrichLoadError(modelUrl, err);
  }
  model.eventMode = "none";
  const modelAny = model as unknown as {
    isInteractive?: unknown;
    removeFromParent?: unknown;
  };
  if (typeof modelAny.isInteractive !== "function") {
    modelAny.isInteractive = function isInteractive(this: { eventMode?: string }) {
      return this.eventMode === "static" || this.eventMode === "dynamic";
    };
  }
  if (typeof modelAny.removeFromParent !== "function") {
    modelAny.removeFromParent = function removeFromParent(this: {
      parent?: { removeChild?: (c: unknown) => void } | null;
    }) {
      this.parent?.removeChild?.(this);
    };
  }

  model.anchor.set(0.5, 1);
  app.stage.addChild(model as never);

  const bounds = computeCharBounds(model as never);
  const baseScale =
    container.clientHeight > 0
      ? (container.clientHeight * heightRatio) / bounds.charHeight
      : 0.5;
  model.scale.set(baseScale);

  const layout = createLayoutController({
    model,
    app,
    hitboxEl,
    bounds,
    baseScale,
    initAnchorX,
  });
  layout.applyLayout();

  const motion = createMotionController(model as never, groupAliases);
  const expression = createExpressionController(model as never, modelBase);
  const look = createLookController(model as never);
  const mouth = createMouthController(model as never);
  const react = createReact({
    resolveGroup: motion.resolveGroup,
    setExpressionFade: expression.setExpressionFade,
    playEmotion: motion.playEmotion,
    isDisposed: () => disposed,
  });

  let disposed = false;
  let frameHooked = false;
  let frameTick: (() => void) | null = null;
  let framePrevMs = performance.now();

  function onBeforeModelUpdate() {
    if (disposed) return;
    const now = performance.now();
    const dtSec = Math.min(0.1, Math.max(0.001, (now - framePrevMs) / 1000));
    framePrevMs = now;
    look.applyLook();
    expression.applyExprLayer(dtSec);
    mouth.tickMouth();
  }

  {
    const internal = model.internalModel as unknown as {
      on?: (ev: string, fn: () => void) => void;
    };
    if (typeof internal?.on === "function") {
      internal.on("beforeModelUpdate", onBeforeModelUpdate);
      frameHooked = true;
    }
    frameTick = () => {
      if (!frameHooked) onBeforeModelUpdate();
    };
    PIXI.Ticker.shared.add(frameTick);
  }

  const syncTick = () => layout.syncResize(container);
  PIXI.Ticker.shared.add(syncTick);

  motion.scheduleIdleMotion();

  return {
    model,
    app,
    startMouth: () => mouth.startMouth(),
    playMotion: (group?: string) => motion.playMotion(group),
    playEmotion: (group: string, opts?: { priority?: "normal" | "force" }) =>
      motion.playEmotion(group, opts),
    setExpression: (name?: string | null) => expression.setExpressionFade(name),
    setLookAt: look.setLookAt,
    setLookEnabled: look.setLookEnabled,
    react,
    listGroups: () => motion.listGroups(),
    isBusyMotion: () => motion.hasActiveMotion(),
    getHitbox: () => readHitbox(hitboxEl),
    setAnchorX: (ratio: number) => layout.setAnchorX(ratio),
    setRetreat: (retreat: boolean, panelSide?: "left" | "right") =>
      layout.setRetreat(retreat, panelSide),
    destroy: () => {
      disposed = true;
      motion.destroy();
      expression.destroy();
      look.destroy();
      mouth.destroy();
      layout.destroy();
      try {
        const internal = model.internalModel as unknown as {
          off?: (ev: string, fn: () => void) => void;
        };
        if (frameHooked && typeof internal?.off === "function") {
          internal.off("beforeModelUpdate", onBeforeModelUpdate);
        }
      } catch {
        /* 忽略 */
      }
      if (frameTick) PIXI.Ticker.shared.remove(frameTick);
      PIXI.Ticker.shared.remove(syncTick);
      hitboxEl.remove();
      try {
        app.destroy(true, { children: true, texture: true });
      } catch (err) {
        console.warn("[pet] app.destroy 异常", err);
      }
      try {
        const anyPixi = PIXI as unknown as {
          utils?: { TextureCache?: Record<string, unknown>; BaseTextureCache?: Record<string, unknown> };
          BaseTextureCache?: Record<string, unknown>;
          TextureCache?: Record<string, unknown>;
        };
        const caches = [
          anyPixi.utils?.TextureCache,
          anyPixi.utils?.BaseTextureCache,
          anyPixi.TextureCache,
          anyPixi.BaseTextureCache,
        ];
        for (const cache of caches) {
          if (!cache) continue;
          for (const key of Object.keys(cache)) delete cache[key];
        }
      } catch {
        /* 忽略 */
      }
    },
  };
}
