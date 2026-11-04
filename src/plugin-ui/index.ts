// 插件 UI 运行时的稳定公共出口：插件只从这里 import。
// 平台内部模块（registry/injection/services）不直接暴露给插件作者。

export * from "./types";
export * from "../ui";
export { SlotRegistry } from "./slots/registry";
export { defineStore } from "./slots/store";
export { DisposableBag, mountPlugins } from "./slots/lifecycle";
export {
  SLOT_REGISTRY_KEY,
  useSlotEntries,
  useSlotRegistry,
  useSlotVersion,
} from "./injection";
export { createClientContext } from "./services";
export { default as SlotOutlet } from "./components/SlotOutlet.vue";
export { default as ConfigForm } from "./components/ConfigForm.vue";
export {
  buildPluginConfigValues,
  draftFromView,
} from "./components/config-values";
export type { PluginConfigDraft } from "./components/config-values";
export type { OnebotStatus, PluginConfigView } from "./services/api";
