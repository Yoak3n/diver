// 设置状态与逻辑入口（插件声明驱动的配置、保存、Sidecar 管理）。
//
// 状态为模块级单例：聊天页注入 TTS、设置页编辑共享同一份，
// 路由切换不丢已填表单。openSettings 只负责拉取/回填，页面切换走 router。
//
// 分层：settings-tabs.ts tab 定义 | settings-state.ts 状态单例与派生
// | settings-actions.ts 拉取/保存/重启动作；本文件只做公共 re-export 与组合出口。

import {
  currentProviderDecl,
  currentProviderModels,
  healthInfo,
  providerDecls,
  settingsInfo,
  state,
} from "./settings-state";
import { changePetSize, doRestartSidecar, openSettings, save, toggleWindowStartup } from "./settings-actions";

export * from "./settings-actions";
export * from "./settings-state";
export * from "./settings-tabs";

export function useSettings() {
  return {
    state,
    settingsInfo,
    healthInfo,
    providerDecls,
    currentProviderDecl,
    currentProviderModels,
    openSettings,
    save,
    doRestartSidecar,
    toggleWindowStartup,
    changePetSize,
  };
}
