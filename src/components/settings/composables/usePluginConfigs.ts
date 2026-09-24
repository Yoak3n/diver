// 插件 config 表单状态（Desktop model-config 风格）。

import { ref } from "vue";
import {
  getPluginConfigsApi,
  savePluginConfigApi,
  type PluginConfigView,
} from "../../../api";

export function usePluginConfigs(hint: { value: string }) {
  const configMap = ref<Record<string, PluginConfigView>>({});
  const draft = ref<Record<string, Record<string, string | boolean>>>({});

  async function loadPluginConfigs() {
    try {
      const res = await getPluginConfigsApi();
      const map: Record<string, PluginConfigView> = {};
      const drafts: Record<string, Record<string, string | boolean>> = {};
      for (const item of res.plugins) {
        map[item.id] = item;
        const values: Record<string, string | boolean> = {};
        for (const f of item.fields) {
          if (f.type === "boolean") values[f.key] = f.value === "true" || f.default === true;
          else values[f.key] = f.value ?? (f.default != null ? String(f.default) : "");
        }
        drafts[item.id] = values;
      }
      configMap.value = map;
      draft.value = drafts;
    } catch {
      configMap.value = {};
    }
  }

  async function onSaveConfig(id: string) {
    const fields = configMap.value[id]?.fields ?? [];
    const values: Record<string, string | number | boolean | null> = {};
    const d = draft.value[id] ?? {};
    for (const f of fields) {
      const raw = d[f.key];
      if (f.type === "boolean") {
        values[f.key] = raw === true || raw === "true";
      } else if (f.type === "number") {
        const s = String(raw ?? "");
        values[f.key] = s === "" ? null : Number(s);
      } else {
        values[f.key] = raw === "" || raw == null ? null : String(raw);
      }
    }
    await savePluginConfigApi(id, values);
    await loadPluginConfigs();
    hint.value = "插件配置已保存，sidecar 重启后生效";
  }

  return { configMap, draft, loadPluginConfigs, onSaveConfig };
}
