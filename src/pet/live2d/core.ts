// Live2D Cubism Core 注入（挂全局 Live2DCubismCore）。
// 必须在 pixi-live2d-display 创建模型前完成；YUI 等 Cubism 5 导出模型需要 moc3 v5 支持。

let pending: Promise<void> | null = null;

/** 确保 Cubism Core 已加载（幂等；并发调用共享同一次注入）。 */
export function ensureLive2dCore(): Promise<void> {
  if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
    return Promise.resolve();
  }
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    // dev：Vite 按源码路径提供 public/ 资源；release：Tauri 静态托管同路径
    script.src = "/pet/live2dcubismcore.min.js";
    script.onload = () => {
      if ((window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore) {
        resolve();
      } else {
        pending = null;
        reject(new Error("Live2D Cubism Core 脚本已加载但未挂载全局对象"));
      }
    };
    script.onerror = () => {
      pending = null;
      reject(new Error("Live2D Cubism Core 加载失败（/pet/live2dcubismcore.min.js）"));
    };
    document.head.appendChild(script);
  });
  return pending;
}
