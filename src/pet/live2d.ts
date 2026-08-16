// Live2D 桌宠渲染封装（pixi-live2d-display + Cubism 4 官方 Core）
// 注意：Live2DCubismCore 全局由 pet.html 中的经典 <script> 标签注入，
// 不能 import "live2dcubismcore"（该包 main 指向 pixi UMD，不是 Core）。

import { Live2DModel } from "pixi-live2d-display/cubism4";
import * as PIXI from "pixi.js";

// 关键：pixi-live2d-display 的 autoUpdate 通过 window.PIXI.Ticker.shared 注册渲染驱动。
// ESM 环境下 PIXI 不会挂到全局，必须手动挂载，否则模型永远不会 update ——
// 表现就是模型完全静止（连呼吸/眨眼都没有）。
(window as unknown as { PIXI?: unknown }).PIXI = PIXI;

const MODEL_URL = "/pet/models/Hiyori/Hiyori.model3.json";

export interface PetModelHandle {
  model: Live2DModel;
  app: PIXI.Application;
  /** 说话口型：循环更新 ParamMouthOpenY（0~1），返回停止函数。 */
  startMouth: () => () => void;
  /** 随机播放一个动作组（如 Idle / TapBody）。 */
  playMotion: (group?: string) => void;
  destroy: () => void;
}

/**
 * 在容器内创建 Live2D 模型（底部锚定、自动交互）。
 * @param container 模型容器
 * @param designWidth 模型设计显示宽度（px）。由调用方传入窗口最小宽度
 *   （PetApp 的 PET_MIN_W=360），模型缩放固定按它计算，不随窗口实际宽度漂移。
 */
export async function createPetModel(container: HTMLElement, designWidth = 360): Promise<PetModelHandle> {
  const app = new PIXI.Application({
    backgroundAlpha: 0,
    resizeTo: container,
    antialias: true,
    autoStart: true,
  });
  container.appendChild(app.view as HTMLCanvasElement);

  // 注意：不能用 autoInteract —— pixi-live2d-display 0.4 依赖 renderer.plugins.interaction
  // 拿交互管理器（pixi 6 API），而 pixi 7.4 中它是 deprecated getter，返回的 EventSystem
  // 没有 .on 方法，会在每次 _render 时抛 "manager.on is not a function"。
  // 因此禁用它，改用 pixi 7 的事件系统自行处理点击。
  const model = await Live2DModel.from(MODEL_URL, { autoInteract: false });
  model.eventMode = "static";

  // 底部居中锚定，宽度适配容器
  model.anchor.set(0.5, 1);
  // 缩放固定按 360px 设计宽度（与 PetApp 的 PET_MIN_W 一致），不取加载瞬间的
  // clientWidth：模型文件加载（网络请求）可能耗时 1s+，期间历史消息气泡会触发
  // 窗口自动拉宽（最长 640px）——若按当时的 clientWidth 计算，模型大小会随
  // 窗口宽度漂移（修复会话后历史长消息立即显示时尤其明显）。
  const scale = Math.min(designWidth / model.width, 1);
  model.scale.set(scale);
  model.x = app.screen.width / 2;
  model.y = app.screen.height;

  app.stage.addChild(model);
  // Tauri setSize 改变 webview 尺寸时不一定触发 window resize 事件，
  // PIXI 的 resizeTo 因此可能停留在旧尺寸 → 模型按旧中心定位（"闪现左边"）。
  // 最稳方案：与模型动画共用 window.PIXI.Ticker.shared（它一定在跑），
  // 每帧比对容器实际尺寸与 renderer screen，不一致立即 resize 并重新居中。
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
    model.x = app.screen.width / 2;
    model.y = app.screen.height;
  };
  PIXI.Ticker.shared.add(syncTick);

  // 注：点按互动/长按拖动由 PetApp 统一管理（避免与长按拖动冲突），
  // 这里不再监听 pointertap。

  function playMotion(group = "TapBody") {
    const manager = model.internalModel.motionManager as any;
    try {
      const defs: any[] = manager?.definitions ?? [];
      const groupDefs = defs.filter((d) => d.group === group);
      if (groupDefs.length > 0) {
        const pick = groupDefs[Math.floor(Math.random() * groupDefs.length)];
        model.motion(group, pick.index);
      } else {
        model.motion(group);
      }
    } catch {
      /* 动作不可用时忽略 */
    }
  }

  // ---------- 无自主 idle 循环 ----------
  // 呼吸/眨眼由 Cubism 内置的 breath/eyeBlink 自动驱动（updateNaturalMovements），
  // 不需要定时播放大动作——之前 7 秒一次的随机 Idle 动作会让模型"突然晃动"，
  // 且与用户交互时机巧合时显得像被操作触发。

  function startMouth(): () => void {
    const core = model.internalModel.coreModel as any;
    let frame = 0;
    let stop = false;
    const timer = window.setInterval(() => {
      if (stop) return;
      frame += 0.6;
      // 正弦抖动模拟说话口型
      const value = Math.abs(Math.sin(frame)) * 0.9;
      try {
        core.setParameterValueById?.("ParamMouthOpenY", value);
      } catch {
        /* 忽略 */
      }
    }, 60);
    return () => {
      stop = true;
      window.clearInterval(timer);
      try {
        core.setParameterValueById?.("ParamMouthOpenY", 0);
      } catch {
        /* 忽略 */
      }
    };
  }

  return {
    model,
    app,
    startMouth,
    playMotion: (group?: string) => playMotion(group),
    destroy: () => {
      PIXI.Ticker.shared.remove(syncTick);
      app.destroy(true, { children: true, texture: true });
    },
  };
}
