// 插件可见的窄 API 面：只暴露插件 UI 需要的端点，不暴露传输细节。

import {
  getOnebotStatusApi,
  getPluginConfigsApi,
  savePluginConfigApi,
  type OnebotStatus,
  type PluginConfigView,
} from "../../api";
import type { PluginApi } from "../types";

export type { OnebotStatus, PluginConfigView };

export function createApiService(): PluginApi {
  return {
    listPluginConfigs: (instanceId) => getPluginConfigsApi(instanceId),
    savePluginConfig: async (id, values, instanceId) => {
      await savePluginConfigApi(id, values, instanceId);
    },
    onebotStatus: (instanceId) => getOnebotStatusApi(instanceId),
  };
}
