// 插件 config 表单状态（Desktop model-config 风格）。
// 多实例：读面按 instanceId getter 寻址；切实例时用请求序号丢弃过期响应。

import { ref } from "vue";
import {
  getPluginConfigsApi,
  savePluginConfigApi,
  type PluginConfigView,
} from "../../../api";
import {
  buildPluginConfigValues,
  type PluginConfigDraft,
} from "../children/pluginConfigValues";

/** 当前作用域实例；undefined = 非 Tauri / 单实例，走 active 实例。 */
type InstanceTarget = () => string | undefined;

export function usePluginConfigs(hint: { value: string }, instanceId?: InstanceTarget) {
  const configMap = ref<Record<string, PluginConfigView>>({});
  const draft = ref<Record<string, PluginConfigDraft>>({});
  const configError = ref("");
  let loadSeq = 0;

  function target(): string | undefined {
    return instanceId?.();
  }

  async function loadPluginConfigs() {
    const seq = ++loadSeq;
    try {
      const res = await getPluginConfigsApi(target());
      if (seq !== loadSeq) return;
      const map: Record<string, PluginConfigView> = {};
      const drafts: Record<string, PluginConfigDraft> = {};
      for (const item of res.plugins) {
        map[item.id] = item;
        const values: PluginConfigDraft = {};
        for (const f of item.fields) {
          if (f.type === "boolean") values[f.key] = f.value === "true" || f.default === true;
          else values[f.key] = f.value ?? (f.default != null ? String(f.default) : "");
        }
        drafts[item.id] = values;
      }
      configMap.value = map;
      draft.value = drafts;
      configError.value = "";
    } catch (e) {
      if (seq !== loadSeq) return;
      configMap.value = {};
      draft.value = {};
      configError.value = e instanceof Error ? e.message : String(e);
    }
  }

  /** 切到不可达实例时清掉上一实例的表单，避免把 A 的值显示成 B 的。 */
  function reset() {
    loadSeq++;
    configMap.value = {};
    draft.value = {};
    configError.value = "";
  }

  async function onSaveConfig(id: string) {
    const fields = configMap.value[id]?.fields ?? [];
    const values = buildPluginConfigValues(fields, draft.value[id] ?? {});
    try {
      await savePluginConfigApi(id, values, target());
      await loadPluginConfigs();
      const name = configMap.value[id]?.title ?? id;
      hint.value = `${name} 配置已保存，sidecar 重启后生效`;
    } catch (e) {
      configError.value = e instanceof Error ? e.message : String(e);
    }
  }

  return { configMap, draft, configError, loadPluginConfigs, reset, onSaveConfig };
}
