// 插件配置表单 → patch 写入值的唯一转换点。
// secret 字段后端不回显：留空 = 保持已保存值，draft 显式为 null = 用户点了「清除」。

import type { PluginConfigFieldView } from "../../../api";

/** 表单草稿：null 表示该键被显式标记清除。 */
export type PluginConfigDraft = Record<string, string | boolean | null>;

export function buildPluginConfigValues(
  fields: PluginConfigFieldView[],
  draft: PluginConfigDraft,
): Record<string, string | number | boolean | null> {
  const values: Record<string, string | number | boolean | null> = {};
  for (const field of fields) {
    const raw = draft[field.key];
    if (field.type === "boolean") {
      values[field.key] = raw === true || raw === "true";
      continue;
    }
    if (raw === null) {
      values[field.key] = null;
      continue;
    }
    const text = String(raw ?? "");
    if (text === "") {
      if (field.secret === true) continue;
      values[field.key] = null;
      continue;
    }
    values[field.key] = field.type === "number" ? Number(text) : text;
  }
  return values;
}
