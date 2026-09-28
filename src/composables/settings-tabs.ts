// 设置页 tab 定义（类型 / 清单 / 守卫）。

export type SettingsTab =
  | "instances"
  | "models"
  | "voice"
  | "mcp"
  | "plugins"
  | "shortcuts"
  | "schedule"
  | "presence"
  | "system";

export const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
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

export function isSettingsTab(v: string): v is SettingsTab {
  return SETTINGS_TABS.some((t) => t.id === v);
}
