// 主窗口自定义标题栏的共享状态（连接指示 / 当前模型）。
// ChatView 写入，App 层 TitleBar 读取 —— 避免把聊天状态硬塞进壳组件。
import { reactive } from "vue";

export type ChromeDot = "on" | "busy" | "off";

export interface ChromeState {
  statusText: string;
  modelLabel: string;
  dotClass: ChromeDot;
}

export const chrome = reactive<ChromeState>({
  statusText: "未连接",
  modelLabel: "",
  dotClass: "off",
});

export function setChrome(patch: Partial<ChromeState>) {
  Object.assign(chrome, patch);
}
