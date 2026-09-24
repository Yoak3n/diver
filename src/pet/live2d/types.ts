// Live2D 桌宠句柄类型。

import type { Live2DModel } from "pixi-live2d-display/cubism4";
import type * as PIXI from "pixi.js";

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
  setAnchorX: (ratio: number) => void;
  /** 面板打开让位：模型缩小 + 偏移到面板对侧（retreat=true 让位，false 恢复）。
   *  panelSide: 面板所在侧（'left' 面板在左 → 模型偏右；'right' 反之）。 */
  setRetreat: (retreat: boolean, panelSide?: "left" | "right") => void;
  /** 角色命中框（相对模型容器的 CSS 像素）。用于点击穿透仅覆盖模型本体。 */
  getHitbox: () => { left: number; top: number; width: number; height: number } | null;
  destroy: () => void;
}

export type GroupAliases = Record<string, string[]>;
