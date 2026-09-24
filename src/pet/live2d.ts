// Live2D 桌宠渲染封装（pixi-live2d-display + Cubism 4 官方 Core）
// 注意：Live2DCubismCore 全局由 pet.html 中的经典 <script> 标签注入，
// 不能 import "live2dcubismcore"（该包 main 指向 pixi UMD，不是 Core）。

import { Live2DModel } from "pixi-live2d-display/cubism4";
import * as PIXI from "pixi.js";
import { getSpeechLevel } from "../tts";

// 关键：pixi-live2d-display 的 autoUpdate 通过 window.PIXI.Ticker.shared 注册渲染驱动。
// ESM 环境下 PIXI 不会挂到全局，必须手动挂载，否则模型永远不会 update ——
// 表现就是模型完全静止（连呼吸/眨眼都没有）。
(window as unknown as { PIXI?: unknown }).PIXI = PIXI;

const DEFAULT_MODEL_URL = "/pet/models/Hiyori/Hiyori.model3.json";

/** moc3 文件头：magic 'MOC3' + uint32 version（与 Cubism MocVersion 枚举一致）。 */
async function readMocVersion(modelUrl: string): Promise<number> {
  const res = await fetch(modelUrl);
  if (!res.ok) throw new Error(`模型描述加载失败：HTTP ${res.status}（${modelUrl}）`);
  const meta = (await res.json()) as { FileReferences?: { Moc?: string } };
  const mocRel = meta.FileReferences?.Moc;
  if (!mocRel) throw new Error("model3.json 缺少 FileReferences.Moc");
  const base = modelUrl.replace(/[^/]*$/, "");
  const mocRes = await fetch(base + mocRel);
  if (!mocRes.ok) throw new Error(`moc3 加载失败：HTTP ${mocRes.status}（${base + mocRel}）`);
  const buf = await mocRes.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== "MOC3") throw new Error(`moc3 魔数异常：${magic}`);
  const ver = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
  return ver >>> 0;
}

/** 当前 Core 支持的最高 moc3 版本（MocVersion_42=4 / MocVersion_50=5）。 */
function coreMaxMocVersion(): number {
  const core = (window as unknown as {
    Live2DCubismCore?: {
      Version?: { csmGetLatestMocVersion?: () => number };
    };
  }).Live2DCubismCore;
  try {
    return core?.Version?.csmGetLatestMocVersion?.() ?? 0;
  } catch {
    return 0;
  }
}

async function assertMocSupported(modelUrl: string): Promise<void> {
  let fileVer: number;
  try {
    fileVer = await readMocVersion(modelUrl);
  } catch (err) {
    throw new Error(
      `读取模型 moc 版本失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const max = coreMaxMocVersion();
  if (max > 0 && fileVer > max) {
    throw new Error(
      `Cubism Core 不支持 moc3 v${fileVer}（当前最高 v${max}）。` +
        `请升级 public/pet/live2dcubismcore.min.js（需含 MocVersion_50）。` +
        `模型：${modelUrl}`,
    );
  }
}

function enrichLoadError(modelUrl: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg && msg !== "Unknown error" && !/unknown error/i.test(msg)) {
    return new Error(`模型加载失败（${modelUrl}）：${msg}`);
  }
  return new Error(
    `模型加载失败（${modelUrl}）：${msg}。` +
      `常见原因：moc3 版本过新 / 贴图路径错误 / WebGL 上下文异常。` +
      `可打开 DevTools 查看 Cubism 日志。`,
  );
}

export interface PetModelHandle {
  model: Live2DModel;
  app: PIXI.Application;
  /**
   * 说话口型：在 motionManager.update 之后每帧写入（避免被动作曲线覆盖）。
   * 有 TTS 音量时用真实响度驱动；否则退回正弦抖动。
   * 返回停止函数。
   */
  startMouth: () => () => void;
  /** 随机播放一个动作组（如 Idle / TapBody）。 */
  playMotion: (group?: string) => void;
  /** 播放一个情绪动作组（Happy/Sad/Angry/...），带节流与优先级控制。 */
  playEmotion: (group: string, opts?: { priority?: "normal" | "force" }) => void;
  /** 切换表情（exp3 名）；传 null/空 清除当前表情层。 */
  setExpression: (name?: string | null) => void;
  /** 鼠标视线追踪：坐标为容器 CSS 像素（与 PIXI screen 一致）。 */
  setLookAt: (x: number, y: number) => void;
  /** 开关视线追踪（默认开）。 */
  setLookEnabled: (on: boolean) => void;
  /**
   * 情绪反应：动作 + 表情同播（表情淡入，结束后差分淡出）。
   * zone: 'head' | 'body' | 'auto' 用于点击分区回退。
   */
  react: (
    emotion: string,
    opts?: { force?: boolean; zone?: "head" | "body" | "auto"; expressions?: string[] },
  ) => void;
  /** 当前模型已声明的动作组名（调试/自适应用）。 */
  listGroups: () => string[];
  /** 当前是否正在播放非 Idle 的动作（用于节流判断）。 */
  isBusyMotion: () => boolean;
  /** 模型水平中心在窗口宽度上的比例（0=左缘，1=右缘）。用于左右分区布局。 */
    /** 模型水平中心在窗口宽度上的比例（0=左缘，1=右缘）。用于左右分区布局。 */
  setAnchorX: (ratio: number) => void;
  /** 面板打开让位：模型缩小 + 偏移到面板对侧（retreat=true 让位，false 恢复）。
   *  panelSide: 面板所在侧（'left' 面板在左 → 模型偏右；'right' 反之）。 */
  setRetreat: (retreat: boolean, panelSide?: "left" | "right") => void;
  /** 角色命中框（相对模型容器的 CSS 像素）。用于点击穿透仅覆盖模型本体。 */
  getHitbox: () => { left: number; top: number; width: number; height: number } | null;
  destroy: () => void;
}

/**
 * 在容器内创建 Live2D 模型（底部锚定、可水平偏置）。
 * @param container 模型容器
 * @param options
 *   - heightRatio: 模型高度占窗口高度的比例（如 0.7 = 占 70%）。
 *     模型大小完全由它决定（单一约束）：调它就生效，且数学上
 *     保证模型高度 ≤ 窗口高度 × 比例，永不超出窗口。
 *   - anchorXRatio: 模型水平中心占容器宽度的比例，默认 0.5（居中）。
 */
export async function createPetModel(
  container: HTMLElement,
  options: {
    heightRatio?: number;
    anchorXRatio?: number;
    /** model3.json 路径；默认 Hiyori */
    modelUrl?: string;
    /** 逻辑动作组 → 候选真实组名（取第一个存在的） */
    groupAliases?: Record<string, string[]>;
  } = {},
): Promise<PetModelHandle> {
  const heightRatio = options.heightRatio ?? 0.7;
  let anchorXRatio = options.anchorXRatio ?? 0.5;
  const modelUrl = options.modelUrl ?? DEFAULT_MODEL_URL;
  const modelBase = modelUrl.replace(/[^/]*$/, "");
  const groupAliases = options.groupAliases ?? {};

  if (!container) {
    throw new Error("createPetModel: container 为空（挂载时机过早或已卸载）");
  }
  /** 面板所在侧（setRetreat 传入），决定让位方向 */
  let panelSideRef: "left" | "right" = "right";

  const app = new PIXI.Application({
    backgroundAlpha: 0,
    resizeTo: container,
    antialias: true,
    autoStart: true,
  });
  const canvas = app.view as HTMLCanvasElement;
  // 画布铺满窗口，但**不**参与命中：透明留白必须鼠标穿透。
  // 可交互面是下面按角色包围盒生成的 .model-hitbox。
  canvas.style.pointerEvents = "none";
  container.appendChild(canvas);

  /** 角色命中框 DOM（仅覆盖模型本体，class interactive 供穿透检测） */
  const hitboxEl = document.createElement("div");
  hitboxEl.className = "model-hitbox interactive";
  hitboxEl.style.pointerEvents = "auto";
  container.appendChild(hitboxEl);

  // 注意：不能用 autoInteract —— pixi-live2d-display 0.4 依赖 renderer.plugins.interaction
  // 拿交互管理器（pixi 6 API），而 pixi 7.4 中它是 deprecated getter，返回的 EventSystem
  // 没有 .on 方法，会在每次 _render 时抛 "manager.on is not a function"。
  // 因此禁用它，改用 DOM hitbox（见上）+ PetApp 的 pointer 处理。
  //
  // Pixi 7 EventBoundary 会对 eventMode=static/dynamic 的节点调用 currentTarget.isInteractive()。
  // pixi-live2d-display 的 Live2DModel 并非经 @pixi/events mixin 完整混入的 Container
  // （还缺 removeFromParent 等），命中测试会抛 "isInteractive is not a function"。
  // 这里：① 不把模型设为可交互（点击穿透用 DOM）；② 兜底补上 isInteractive，避免
  // stage 走查子树时再次炸掉。
  //
  // Core 版本：public/pet/live2dcubismcore.min.js 必须支持目标模型的 moc3 版本。
  // YUI（N.E.K.O）是 moc3 v5（MocVersion_50），旧 Core 最高 v4 会 reviveMoc 失败，
  // pixi-live2d-display 只吐 "Unknown error"。加载前做一次 moc 版本探测，给出可读原因。
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

  // 底部锚定，宽度固定（不随窗口宽度漂移）
  model.anchor.set(0.5, 1);

  app.stage.addChild(model as never);

  // ---------- 角色实际绘制范围（而非画布） ----------
  // model.width 是画布宽（CanvasWidth，Hiyori 约 2048px），角色通常只占画布一部分。
  // 若按画布算缩放（designWidth / model.width），角色实际显示宽度会远小于设计值，
  // 且调大 designWidth 时增量大部分被画布留白吞掉 —— 这就是"模型看起来没变大"的原因。
  // 因此以"可见图元的顶点包围盒"（模型局部坐标）为基准计算角色真实尺寸。
  // 注：internalModel.coreModel 是 CubismModel 包装层（getDrawableCount 等），
  // 而 internalModel.getDrawableVertices(i) 返回模型局部坐标（中心原点、y 向下），
  // 与渲染管线一致（含 PPU 换算 + 居中平移）。
  const wrapper = model.internalModel.coreModel as any;
  const internal = model.internalModel as any;
  const canvasW = model.internalModel.width; // 画布宽（物理像素）
  const canvasH = model.internalModel.height;
  let charWidth = canvasW; // 回退：画布宽
  let charHeight = canvasH;
  /** 角色中心相对画布中心的 x 偏移（画布单位，右为正） */
  let charCenterOffsetX = 0;
  /** 角色底边相对画布底边的偏移（画布单位，0 = 脚贴画布底边） */
  let charBottomOffset = 0;
  try {
    const count = wrapper?.getDrawableCount?.() ?? 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      // 用 opacity>0 过滤不可见图元（背景/下絵等）。
      // 注意：不能用动态可见标志（getDrawableDynamicFlagIsVisible）——它在
      // update 后会被 reset，模型刚加载、首帧渲染前读取时全部为 false，
      // 会把角色包围盒算空而回退到画布尺寸（又变回"按画布缩放、角色偏小"）。
      const opacity = wrapper?.getDrawableOpacity?.(i);
      if (opacity === undefined || opacity <= 0) continue;
      // 画布坐标（左上原点、y 向下），与渲染管线（centeringTransform）一致
      const verts: number[] | Float32Array | undefined = internal?.getDrawableVertices?.(i);
      if (!verts) continue;
      for (let v = 0; v < verts.length; v += 2) {
        const x = verts[v], y = verts[v + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (isFinite(minX) && isFinite(maxX) && maxX > minX) {
      charWidth = maxX - minX;
      charHeight = maxY - minY;
      charCenterOffsetX = (minX + maxX) / 2 - canvasW / 2;
      charBottomOffset = canvasH - maxY; // 角色底边在画布底边上方多少
    } else {
      console.warn(`[pet] 包围盒计算为空（count=${count}），回退画布尺寸`);
    }
  } catch (err) {
    console.warn("[pet] 计算角色包围盒失败，回退到画布尺寸:", err);
  }

  // ---------- 基础缩放：模型高度 = 窗口高度 × heightRatio ----------
  // 单一约束（不做宽度/高度双约束）——双约束时 Hiyori 角色高宽比大，
  // 高度约束永远先命中，改宽度参数无效（"改了半天没变化"的根源）。
  // 现在只按高度比例算 scale：调 heightRatio 立即生效，
  // 且模型高度 = 窗口高 × heightRatio，数学上永不超出窗口。
  const baseScale = container.clientHeight > 0
    ? (container.clientHeight * heightRatio) / charHeight
    : 0.5;
  model.scale.set(baseScale);

  // ---------- 面板让位：模型缩小 + 偏移到对侧（平滑过渡） ----------
  let retreating = false;
  /** 原始分区偏置（面板关闭时恢复） */
  let baseAnchorXRatio = anchorXRatio;

  /** 当前缩放值（平滑过渡用） */
  let currentScale = baseScale;
  /** 目标缩放值 */
  let targetScale = baseScale;
  /** 当前水平中心比例（平滑过渡用） */
  let currentAnchorX = anchorXRatio;
  /** 目标水平中心比例 */
  let targetAnchorX = anchorXRatio;
  let animTimer: number | null = null;

  /** 面板宽度（与 PetApp.vue 的 .bubble-area width 保持一致）。
   *  面板:模型画布 = 1.2:1 —— 模型高 448px（560×0.8）→ 画布显示宽约 319px，
   *  面板 = 319 × 1.2 ≈ 383px。 */
  const PANEL_WIDTH = 383;

  /** 让位时模型相对常态的缩放比例（呼出面板后适当缩小）。
   *  高度随之等比缩小（如常态 70% → 让位约 61%），
   *  宽度受面板对侧可用空间约束不溢出。 */
  const RETREAT_SCALE_RATIO = 0.87;

  /** 让位时角色能用的最大宽度（px，防止面板对侧空间不足时溢出）。
   *  面板对侧实际可用宽度 = 窗口宽 - 面板宽 - 边距。 */
  function retreatMaxCharWidth(): number {
    const margin = 24; // 面板与角色之间的最小间距
    return app.screen.width - PANEL_WIDTH - margin;
  }

  /** 让位后角色中心的水平位置（px，窗口内），使角色紧贴面板（间距 margin）。
   *  面板在右 → 角色右缘贴面板左缘；面板在左 → 角色左缘贴面板右缘。
   *  @param scale 让位后的缩放值（决定角色当前宽度，用于算边缘） */
  function retreatTargetCenterX(scale: number): number {
    const margin = 24; // 面板与角色之间的最小间距
    const charScreenW = scale * charWidth; // 角色当前显示宽度
    const side = panelSideRef === "left" ? "left" : "right";
    if (side === "right") {
      // 面板在右：角色右缘 = 面板左缘 - margin
      const panelLeft = app.screen.width - PANEL_WIDTH;
      return panelLeft - margin - charScreenW / 2;
    }
    // 面板在左：角色左缘 = 面板右缘 + margin
    const panelRight = PANEL_WIDTH;
    return panelRight + margin + charScreenW / 2;
  }

  function computeTargets() {
    if (retreating) {
      // 让位：模型相对常态缩小到 RETREAT_SCALE_RATIO（适当缩小，呼出面板后
      // 不占满面板对侧，也不会因常态受高度约束而"没缩"）。
      const maxScale = retreatMaxCharWidth() / charWidth; // 面板对侧可容纳的最大 scale
      targetScale = Math.min(baseScale * RETREAT_SCALE_RATIO, maxScale);
      // 角色中心屏幕位置 = model.x + charCenterOffsetX×scale = screenW×anchorX
      // （applyLayout 里 model.x = screenW×anchorX - charCenterOffsetX×scale，
      //  两者抵消）。因此让角色中心落在 retreatTargetCenterX(scale) 处，直接
      //  anchorX = centerX / screenW，无需再加 charCenterOffsetX 补偿。
      targetAnchorX = retreatTargetCenterX(targetScale) / app.screen.width;
    } else {
      targetScale = baseScale;
      targetAnchorX = baseAnchorXRatio;
    }
  }

  function applyLayout() {
    // 锚点 anchor=(0.5,1) → pivot 在画布底边中心，model.x/model.y 即画布底边中心的屏幕位置。
    // 角色包围盒是画布坐标（左上原点、y 向下）：
    //   - 角色中心相对画布中心水平偏移 = charCenterOffsetX * scale
    //   - 角色底边相对画布底边垂直偏移 = charBottomOffset * scale（角色底边在画布底边上方）
    // 让角色脚底贴窗口底部：画布底边中心 y = screenH + charBottomOffset*scale（往下推，
    // 把"角色脚底到画布底边"的空白移出屏幕）。
    model.x = app.screen.width * currentAnchorX - charCenterOffsetX * currentScale;
    model.y = app.screen.height + charBottomOffset * currentScale;
    updateHitbox();
  }

  /**
   * 按角色包围盒（非整块画布）更新命中框。
   *
   * 屏幕坐标（容器 CSS 像素，与 PIXI screen 一致）：
   * - 角色中心 X = screenW × currentAnchorX（applyLayout 已保证）
   * - 角色脚底 Y = screenH（贴窗口底）
   * - 显示宽/高 = charWidth/Height × currentScale
   *
   * 略放大命中框：动作/头发会略超出静态顶点包围盒，避免边缘点不中。
   */
  function updateHitbox() {
    const scale = currentScale;
    const charW = charWidth * scale;
    const charH = charHeight * scale;
    // 动作外扩：宽 +8%、高 +5%（左右发饰/抬手），仍远小于整窗画布留白
    const padX = charW * 0.08;
    const padY = charH * 0.05;
    const centerX = app.screen.width * currentAnchorX;
    const bottomY = app.screen.height;
    const left = centerX - charW / 2 - padX;
    const top = bottomY - charH - padY;
    const width = charW + padX * 2;
    const height = charH + padY * 2;
    hitboxEl.style.left = `${left}px`;
    hitboxEl.style.top = `${top}px`;
    hitboxEl.style.width = `${width}px`;
    hitboxEl.style.height = `${height}px`;
  }

  // ---------- 平滑过渡：分层缓动补间 ----------
  // 帧率无关（按 performance.now 推进），只补间 scale 与 anchorX 两个标量，
  // 位置由 applyLayout 统一计算，不触碰坐标公式（避免上次"重复补偿导致
  // 模型飞出窗口"的问题）。
  // 位移与缩放用不同的缓动节奏：
  //  - 位移 easeInOutCubic（起止都缓，像"滑过去"，不过冲避免进面板）
  //  - 缩放 easeOutBack（带轻微回弹）—— 模型"站定后轻轻一顿"，
  //    配合"发现自己被挡住了、站出来"的叙事感更生动。
  const ANIM_DURATION_MS = 520; // 让位/恢复的过渡时长（略长，换边更从容）
  /** 动画起点（scale 与 anchorX） */
  let animFromScale = baseScale;
  let animFromAnchorX = anchorXRatio;
  /** 动画开始时间戳（performance.now，ms） */
  let animStart = 0;

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

  // 注意：Ticker listener 回调参数是 deltaTime（帧间隔），不是时间戳，
  // 因此动画时间统一用 performance.now()（与 animStart 同源）。
  function animateStep() {
    const t = Math.min(1, Math.max(0, (performance.now() - animStart) / ANIM_DURATION_MS));
    // 位移：全程 easeInOutCubic（起止平滑、中段最快）
    const eMove = easeInOutCubic(t);
    // 缩放：easeOutBack（先快后慢 + 回弹），并让它在位移进行到 ~15% 后才开始
    // （t<0.15 时保持起点，避免"先缩再移"的割裂感，而是"边移边缩"）
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

  // Tauri setSize 改变 webview 尺寸时不一定触发 window resize 事件，
  // PIXI 的 resizeTo 因此可能停留在旧尺寸 → 模型按旧中心定位（"闪现左边"）。
  // 最稳方案：与模型动画共用 window.PIXI.Ticker.shared（它一定在跑），
  // 每帧比对容器实际尺寸与 renderer screen，不一致立即 resize 并重新布局。
  // 注意：resize 必须独立 try-catch —— 若它抛错会中断本回调，model.x 永不更新。
  const syncTick = () => {
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
  };
  PIXI.Ticker.shared.add(syncTick);

  // 注：点按互动/长按拖动由 PetApp 统一管理（避免与长按拖动冲突），
  // 这里不再监听 pointertap。

  /** motionManager.definitions 是 `{ [group]: Definition[] }`（对象），不是数组。 */
  function getMotionDefs(group: string): any[] {
    const defs = (model.internalModel.motionManager as any)?.definitions;
    if (!defs) return [];
    if (Array.isArray(defs)) {
      return defs.filter((d: any) => d?.group === group);
    }
    const list = defs[group];
    return Array.isArray(list) ? list : [];
  }

  /** 逻辑组 → 第一个在模型中真实存在的组名。 */
  function resolveGroup(logical: string): string | null {
    const candidates = groupAliases[logical]?.length
      ? groupAliases[logical]
      : [logical];
    for (const g of candidates) {
      if (groupExists(g)) return g;
    }
    // 再兜底：把逻辑名转小写/常见别名试一遍
    const lower = logical.toLowerCase();
    if (lower !== logical && groupExists(lower)) return lower;
    return null;
  }

  function playMotion(group = "TapBody") {
    const resolved = resolveGroup(group) ?? resolveGroup("TapBody") ?? resolveGroup("Idle");
    if (!resolved) {
      console.warn("[pet] playMotion: 无可用动作组", group, listGroups());
      return;
    }
    try {
      const groupDefs = getMotionDefs(resolved);
      if (groupDefs.length > 0) {
        const index = Math.floor(Math.random() * groupDefs.length);
        void model.motion(resolved, index).catch(() => {});
      } else {
        void model.motion(resolved).catch(() => {});
      }
    } catch (err) {
      console.warn("[pet] playMotion 失败", resolved, err);
    }
  }

  // ---------- 情绪动作播放控制 ----------
  // 非 Idle 情绪动作（Happy/Sad/Angry/...）一次性播放，播完自动回 Idle。
  // 通过监听 motionFinish 事件 + MotionPriority 抢占规则实现：
  //   - 情绪动作用 NORMAL(2) 播放（可抢占 IDLE(1) 的随机 Idle）
  //   - 若已有情绪动作在播（NORMAL 或更高），普通情绪请求被节流跳过，
  //     force 请求用 FORCE(3) 抢占（如点击互动）
  /** 当前是否正在播放非 Idle 动作（motionFinish 时复位）。 */
  let emotionMotionActive = false;
  /** 上次情绪动作结束时间（节流：避免连续消息触发动作过密）。 */
  let lastEmotionEnd = 0;
  const EMOTION_COOLDOWN_MS = 2200;
  /** force（点击）同类动作组冷却：连点同一分区不刷屏，但仍可打断旧动作。 */
  const FORCE_GROUP_COOLDOWN_MS = 450;
  /** resolved group → 上次开播时间（同类节流） */
  const lastGroupPlayAt = new Map<string, number>();
  /** 模型销毁标记（避免异步回调操作已销毁模型）。 */
  let disposed = false;

  /** 判断当前是否正有动作在播（当前优先级 > IDLE）。 */
  function hasActiveMotion(): boolean {
    try {
      const state = (model.internalModel.motionManager as any)?.state as
        | { currentPriority?: number }
        | undefined;
      return typeof state?.currentPriority === "number" && state.currentPriority > 1;
    } catch {
      return emotionMotionActive;
    }
  }

  /** 判断动作组是否存在于模型定义中。 */
  function groupExists(group: string): boolean {
    try {
      return getMotionDefs(group).length > 0;
    } catch {
      return false;
    }
  }

  /** 动作结束后复位状态（motionFinish 事件）。 */
  function onMotionFinish() {
    emotionMotionActive = false;
    lastEmotionEnd = performance.now();
    if (emotionTimeout !== null) {
      window.clearTimeout(emotionTimeout);
      emotionTimeout = null;
    }
  }
  /** 兜底：动作加载失败/卡住时强制复位（防止状态卡死）。 */
  let emotionTimeout: number | null = null;
  function armEmotionTimeout() {
    if (emotionTimeout !== null) window.clearTimeout(emotionTimeout);
    emotionTimeout = window.setTimeout(() => {
      emotionMotionActive = false;
      emotionTimeout = null;
    }, 6000);
  }
  try {
    (model.internalModel.motionManager as any)?.on?.("motionFinish", onMotionFinish);
  } catch {
    /* 事件系统不可用时仅靠定时器兜底 */
  }

  /**
   * 播放情绪动作组。
   * @param group 动作组名（Happy/Sad/Angry/Surprised/Shy/Nod/Wave/TapBody）
   * @param opts.priority 'normal'（默认，受节流限制）| 'force'（无视节流，可抢占）
   */
  function playEmotion(group: string, opts?: { priority?: "normal" | "force" }) {
    if (disposed || !group) return;
    const force = opts?.priority === "force";
    const now = performance.now();

    // 节流：普通情绪请求在冷却期内跳过；force 仍受「同类组」短冷却
    if (!force && now - lastEmotionEnd < EMOTION_COOLDOWN_MS) return;
    // 已有动作在播时，普通请求跳过；force 允许抢占
    if (!force && hasActiveMotion()) return;
    // 逻辑组名经别名表解析（Hiyori 的 Happy、YUI 的 happy 等）
    const resolved = resolveGroup(group);
    if (!resolved) {
      console.warn("[pet] playEmotion: 组不存在", group, "→", listGroups());
      return;
    }
    // 同类节流：同一动作组短冷却内不重复开播
    const lastGroup = lastGroupPlayAt.get(resolved) ?? 0;
    if (now - lastGroup < FORCE_GROUP_COOLDOWN_MS) {
      console.log("[pet] playEmotion 同类节流", resolved);
      return;
    }

    try {
      const groupDefs = getMotionDefs(resolved);
      let index: number | undefined;
      if (groupDefs.length > 0) {
        index = Math.floor(Math.random() * groupDefs.length);
      }
      const priority = force ? 3 : 2; // FORCE : NORMAL
      emotionMotionActive = true;
      lastGroupPlayAt.set(resolved, now);
      armEmotionTimeout();
      console.log("[pet] playEmotion", group, "→", resolved, "idx", index, "force", force);
      // model.motion() 异步加载并播放；状态复位由 motionFinish 事件负责，
      // promise 结果不可靠（force 抢占时旧动作会 resolve false，但新动作已开始）。
      // 这里只吞掉 rejection，避免 unhandled rejection 噪音。
      void model.motion(resolved, index, priority).catch((err) => {
        console.warn("[pet] motion 播放失败", resolved, err);
      });
    } catch (err) {
      console.warn("[pet] playEmotion 异常", err);
      emotionMotionActive = false;
      if (emotionTimeout !== null) {
        window.clearTimeout(emotionTimeout);
        emotionTimeout = null;
      }
    }
  }

  function setExpression(name?: string | null): boolean {
    if (disposed) return false;
    try {
      const manager = (model.internalModel as any)?.motionManager?.expressionManager;
      if (!name) {
        if (typeof model.expression === "function") void model.expression();
        else manager?.resetExpression?.();
        return true;
      }
      if (typeof model.expression === "function") {
        void model.expression(name);
        return true;
      }
      if (manager?.setExpression) {
        manager.setExpression(name);
        return true;
      }
      return false;
    } catch (err) {
      console.warn("[pet] setExpression 失败", name, err);
      return false;
    }
  }

  // ---------- 视线追踪（对齐 N.E.K.O 的 focus / LookAt） ----------
  // autoInteract 在 pixi7 下会炸，这里手动喂 model.focus()，
  // 由 Cubism4InternalModel.updateFocus 映射到 EyeBall/Angle/BodyAngle。
  let lookEnabled = true;
  /** 最近一次目标焦点（容器 CSS 像素） */
  let lookTarget: { x: number; y: number } | null = null;

  function setLookAt(x: number, y: number) {
    lookTarget = { x, y };
  }
  function setLookEnabled(on: boolean) {
    lookEnabled = on;
  }
  function applyLook() {
    if (disposed || !lookEnabled || !lookTarget) return;
    try {
      // Live2DModel.focus(x, y)：传入 stage/全局坐标
      (model as unknown as { focus?: (x: number, y: number, instant?: boolean) => void }).focus?.(
        lookTarget.x,
        lookTarget.y,
      );
    } catch {
      /* 忽略 */
    }
  }

  // ---------- 表情层：淡入 + 差分淡出（简化版 N.E.K.O smoothReset） ----------
  // 在 beforeModelUpdate 里对「表情目标参数」做加性叠加，
  // 不打断 idle motion / focus / breath / physics。
  type ExprParam = { id: string; value: number };
  let exprOverride: ExprParam[] | null = null;
  let exprWeight = 0; // 0~1 当前叠加权重
  let exprTargetWeight = 0;
  let exprFadeSpeed = 0; // 每秒权重变化
  const EXPR_FADE_IN_MS = 220;
  const EXPR_FADE_OUT_MS = 320;

  function loadExprParamsFromName(name: string): ExprParam[] {
    try {
      const em = (model.internalModel as any)?.motionManager?.expressionManager;
      // Cubism4ExpressionManager.definitions 是数组，元素含 Name / File（Parameters 在 exp3 里）
      const defs = em?.definitions ?? [];
      const list = Array.isArray(defs) ? defs : Object.values(defs ?? {});
      for (const d of list as any[]) {
        const n = d?.Name ?? d?.name ?? d?.id;
        if (n !== name) continue;
        const inline = d?.Parameters ?? d?.parameters;
        if (Array.isArray(inline) && inline.length) {
          return inline
            .map((p: any) => ({
              id: String(p?.Id ?? p?.id ?? ""),
              value: Number(p?.Value ?? p?.value ?? 0),
            }))
            .filter((p: ExprParam) => p.id);
        }
      }
    } catch {
      /* 忽略 */
    }
    return [];
  }

  /** 从 exp3 文件拉表情参数（definitions 只有 Name/File，Parameters 在文件里）。 */
  async function loadExprParamsFromFile(name: string): Promise<ExprParam[]> {
    try {
      const em = (model.internalModel as any)?.motionManager?.expressionManager;
      const defs = em?.definitions ?? [];
      const list = Array.isArray(defs) ? defs : Object.values(defs ?? {});
      let file: string | null = null;
      for (const d of list as any[]) {
        const n = d?.Name ?? d?.name ?? d?.id;
        if (n === name && d?.File) {
          file = String(d.File);
          break;
        }
      }
      if (!file) return [];
      const url = file.startsWith("http") ? file : modelBase + file.replace(/^\.\//, "");
      const res = await fetch(url);
      if (!res.ok) return [];
      const json = (await res.json()) as { Parameters?: any[] };
      return (json.Parameters ?? [])
        .map((p: any) => ({
          id: String(p?.Id ?? ""),
          value: Number(p?.Value ?? 0),
        }))
        .filter((p: ExprParam) => p.id);
    } catch {
      return [];
    }
  }

  function setExpressionFade(name?: string | null) {
    if (disposed) return;
    if (!name) {
      exprTargetWeight = 0;
      exprFadeSpeed = 1 / (EXPR_FADE_OUT_MS / 1000);
      return;
    }
    // 先试原生 expression；再叠加手动参数层（保证淡入淡出可见）
    const ok = setExpression(name);
    void loadExprParamsFromFile(name)
      .then(async (fromFile) => {
        if (disposed) return;
        let params = fromFile.length ? fromFile : loadExprParamsFromName(name);
        if (!params.length) params = await loadExprParamsFromFile(name);
        if (params.length) {
          exprOverride = params;
          exprTargetWeight = 1;
          exprFadeSpeed = 1 / (EXPR_FADE_IN_MS / 1000);
        }
        console.log("[pet] setExpression", name, "native", ok, "params", params.length);
      })
      .catch(() => {
        console.log("[pet] setExpression", name, "native", ok, "params 0");
      });
  }

  function applyExprLayer(dtSec: number) {
    if (disposed) return;
    if (exprWeight === 0 && exprTargetWeight === 0) {
      exprOverride = null;
      return;
    }
    // 权重趋近目标
    if (exprWeight < exprTargetWeight) {
      exprWeight = Math.min(exprTargetWeight, exprWeight + exprFadeSpeed * dtSec);
    } else if (exprWeight > exprTargetWeight) {
      exprWeight = Math.max(exprTargetWeight, exprWeight - exprFadeSpeed * dtSec);
      if (exprWeight === 0) exprOverride = null;
    }
    if (!exprOverride || exprWeight <= 0) return;
    try {
      const core = model.internalModel.coreModel as any;
      for (const p of exprOverride) {
        if (typeof core.addParameterValueById === "function") {
          core.addParameterValueById(p.id, p.value * exprWeight);
        } else if (typeof core.setParameterValueById === "function") {
          const cur = core.getParameterValueById?.(p.id) ?? 0;
          core.setParameterValueById(p.id, cur + p.value * exprWeight);
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  // ---------- Idle 随机小动作 ----------
  let idleTimer: number | null = null;
  const IDLE_MIN_MS = 14000;
  const IDLE_JITTER_MS = 12000;
  function scheduleIdleMotion() {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    const delay = IDLE_MIN_MS + Math.random() * IDLE_JITTER_MS;
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      if (disposed) return;
      if (!hasActiveMotion() && !emotionMotionActive && !speakingLock) {
        playMotion(resolveGroup("Idle") ?? resolveGroup("neutral") ?? "Idle");
      }
      scheduleIdleMotion();
    }, delay);
  }
  /** 朗读中不播大动作（由 PetApp 通过 playEmotion 节流；这里仅 idle 用）。 */
  let speakingLock = false;

  /**
   * 情绪反应入口：动作 + 表情同播。
   * zone 用于点击分区：head → Shy/Surprised 倾向；body → TapBody/happy。
   */
  function react(
    emotion: string,
    opts?: { force?: boolean; zone?: "head" | "body" | "auto"; expressions?: string[] },
  ) {
    if (disposed) return;
    const force = opts?.force === true;
    const zone = opts?.zone ?? "auto";

    /** 取第一个模型里真实存在的动作组（yui-origin 无 shy，需兜底）。 */
    const firstGroup = (...names: string[]): string => {
      for (const n of names) {
        const g = resolveGroup(n);
        if (g) return g;
      }
      return resolveGroup("happy") ?? resolveGroup("neutral") ?? resolveGroup("Idle") ?? "Idle";
    };

    // 动作逻辑名：点击分区可覆盖（head→shy/surprised / body→TapBody/happy）
    let logical = emotion;
    if (zone === "head" && emotion === "neutral") {
      logical = firstGroup("shy", "Shy", "surprised", "happy");
    } else if (zone === "body" && emotion === "neutral") {
      logical = firstGroup("TapBody", "happy", "neutral");
    } else if (!resolveGroup(logical)) {
      logical = firstGroup(logical, "happy", "neutral");
    }

    // 表情与动作对齐（点脸=害羞/惊讶脸，点身=开心脸）
    const faceKey =
      logical === "shy" || logical === "Shy"
        ? "shy"
        : logical === "surprised"
          ? "surprised"
          : logical === "TapBody" || logical === "happy"
            ? "happy"
            : logical;
    const exprName = opts?.expressions?.length
      ? pick(opts.expressions)
      : emotionToExprName(faceKey);
    if (exprName) setExpressionFade(exprName);

    console.log("[pet] react", { emotion, zone, logical, faceKey, exprName, force });
    playEmotion(logical, { priority: force ? "force" : "normal" });
  }

  /** 情绪 → 候选表情名（模型无关的软映射，调用方可覆盖）。 */
  function emotionToExprName(emotion: string): string | null {
    const map: Record<string, string[]> = {
      happy: ["expression3", "expression4", "yyy", "xxy", "by"],
      excited: ["expression3", "expression4", "yyy", "xxy"],
      sad: ["by", "expression5", "wy"],
      angry: ["expression2", "expression9", "bzy"],
      surprised: ["expression6", "expression7", "k1", "z1"],
      shy: ["expression11", "expression12", "s1", "syhs"],
      love: ["expression4", "expression11", "xxy"],
      grateful: ["expression3", "by", "yyy"],
      greeting: ["expression3", "yyy"],
      farewell: ["by"],
      agree: ["expression3", "001"],
      neutral: ["by", "expression3", "001"],
      TapBody: ["expression3", "happy"],
    };
    const list = map[emotion] ?? map.neutral;
    return pick(list);
  }

  function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function listGroups(): string[] {
    try {
      const defs = (model.internalModel.motionManager as any)?.definitions;
      if (!defs) return [];
      if (Array.isArray(defs)) {
        return [...new Set(defs.map((d: any) => d?.group).filter(Boolean))] as string[];
      }
      return Object.keys(defs);
    } catch {
      return [];
    }
  }

  // ---------- 统一帧钩子：视线 / 表情层 / 口型 都在 beforeModelUpdate 写入 ----------
  // Cubism4InternalModel.update()：motion → saveParameters → expression/physics →
  //   emit("beforeModelUpdate") → model.update() 烘焙 → loadParameters()
  // 只有 beforeModelUpdate 里的写入能进本帧网格。
  let mouthActive = false;
  let mouthFrame = 0;
  let mouthOpenSmooth = 0;
  let framePrevMs = performance.now();

  function sampleMouthTarget(): number {
    mouthFrame += 0.42;
    const level = getSpeechLevel();
    if (level > 0) return Math.min(1, Math.max(0, level * 3.2));
    const syllable = Math.abs(Math.sin(mouthFrame));
    const wobble = 0.55 + 0.45 * Math.sin(mouthFrame * 0.37 + 1.1);
    return Math.min(1, syllable * wobble * 1.2);
  }

  function writeMouth(open: number) {
    const core = model.internalModel.coreModel as any;
    const form = open * 0.55 - 0.15;
    try {
      if (typeof core.setParameterValueById === "function") {
        core.setParameterValueById("ParamMouthOpenY", open);
        core.setParameterValueById("ParamMouthForm", form);
        core.setParameterValueById("Param71", open * 0.85);
      }
    } catch {
      /* 忽略 */
    }
  }

  function onBeforeModelUpdate() {
    if (disposed) return;
    const now = performance.now();
    const dtSec = Math.min(0.1, Math.max(0.001, (now - framePrevMs) / 1000));
    framePrevMs = now;
    applyLook();
    applyExprLayer(dtSec);
    if (mouthActive) {
      const target = sampleMouthTarget();
      mouthOpenSmooth += (target - mouthOpenSmooth) * 0.5;
      writeMouth(mouthOpenSmooth);
    }
  }

  let frameHooked = false;
  let frameTick: (() => void) | null = null;
  {
    const internal = model.internalModel as any;
    if (typeof internal?.on === "function") {
      internal.on("beforeModelUpdate", onBeforeModelUpdate);
      frameHooked = true;
    }
    frameTick = () => {
      if (!frameHooked) onBeforeModelUpdate();
    };
    PIXI.Ticker.shared.add(frameTick);
  }

  function startMouth(): () => void {
    mouthActive = true;
    mouthOpenSmooth = 0;
    return () => {
      mouthActive = false;
      writeMouth(0);
    };
  }

  // 启动 Idle 随机小动作（③）
  scheduleIdleMotion();

  return {
    model,
    app,
    startMouth,
    playMotion: (group?: string) => playMotion(group),
    playEmotion: (group: string, opts?: { priority?: "normal" | "force" }) =>
      playEmotion(group, opts),
    setExpression: (name?: string | null) => setExpressionFade(name),
    setLookAt,
    setLookEnabled,
    react,
    listGroups,
    isBusyMotion: () => hasActiveMotion() || emotionMotionActive,
    getHitbox: () => {
      const left = parseFloat(hitboxEl.style.left) || 0;
      const top = parseFloat(hitboxEl.style.top) || 0;
      const width = parseFloat(hitboxEl.style.width) || 0;
      const height = parseFloat(hitboxEl.style.height) || 0;
      if (width <= 0 || height <= 0) return null;
      return { left, top, width, height };
    },
    setAnchorX: (ratio: number) => {
      const clamped = Math.min(1, Math.max(0, Number(ratio) || 0));
      if (clamped === anchorXRatio) return;
      anchorXRatio = clamped;
      if (!retreating) {
        baseAnchorXRatio = clamped;
        currentAnchorX = clamped;
        applyLayout();
      }
    },
    setRetreat: (retreat: boolean, panelSide?: "left" | "right") => {
      const next = retreat === true;
      // 面板侧向变化：更新引用（即使 retreat 状态没变也要重算位置，
      // 否则窗口跨屏移动后面板换边、模型还停在旧侧被面板遮住）
      const sideChanged = panelSide !== undefined && panelSide !== panelSideRef;
      if (panelSide) panelSideRef = panelSide;
      // 状态和方向都没变 → 无操作
      if (next === retreating && !sideChanged) return;
      retreating = next;
      computeTargets();
      // 启动平滑过渡：从"当前值"开始补间到目标（中途切换方向也从当前位置续接）
      animFromScale = currentScale;
      animFromAnchorX = currentAnchorX;
      animStart = performance.now();
      if (animTimer === null) {
        PIXI.Ticker.shared.add(animTick);
        animTimer = 1;
      }
      applyLayout();
    },
    destroy: () => {
      disposed = true;
      if (emotionTimeout !== null) {
        window.clearTimeout(emotionTimeout);
        emotionTimeout = null;
      }
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
      try {
        (model.internalModel.motionManager as any)?.off?.("motionFinish", onMotionFinish);
      } catch {
        /* 忽略 */
      }
      try {
        const internal = model.internalModel as any;
        if (frameHooked && typeof internal?.off === "function") {
          internal.off("beforeModelUpdate", onBeforeModelUpdate);
        }
      } catch {
        /* 忽略 */
      }
      if (frameTick) PIXI.Ticker.shared.remove(frameTick);
      PIXI.Ticker.shared.remove(syncTick);
      PIXI.Ticker.shared.remove(animTick);
      hitboxEl.remove();
      try {
        app.destroy(true, { children: true, texture: true });
      } catch (err) {
        console.warn("[pet] app.destroy 异常", err);
      }
      // 清 PIXI 纹理缓存：避免切换模型后 “BaseTexture already had an entry”
      // 与 WebGL deleted object / wrong context 报错
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
