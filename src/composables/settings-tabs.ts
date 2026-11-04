// 设置页 tab 定义（类型 / 清单 / 守卫）。
// 基础 tab 由产品固定；插件 tab 经 settings.tab slot 动态注册。

export type BaseSettingsTab =
  | "instances"
  | "models"
  | "voice"
  | "mcp"
  | "plugins"
  | "shortcuts"
  | "schedule"
  | "presence"
  | "system";

/** 动态 tab id 来自插件注册，运行时才知道。 */
export type SettingsTab = BaseSettingsTab | (string & {});

export const SETTINGS_TABS: Array<{ id: BaseSettingsTab; label: string }> = [
  { id: "instances", label: "实例" },
  { id: "models", label: "模型与提供商" },
  { id: "voice", label: "语音" },
  { id: "mcp", label: "MCP 服务" },
  { id: "plugins", label: "插件" },
  { id: "shortcuts", label: "快捷键" },
  { id: "schedule", label: "日程" },
  { id: "presence", label: "状态机" },
  { id: "system", label: "系统" },
];

export function isBaseSettingsTab(v: string): v is BaseSettingsTab {
  return SETTINGS_TABS.some((t) => t.id === v);
}
