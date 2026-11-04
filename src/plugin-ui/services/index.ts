// 插件客户端服务的装配入口。

import type { SlotRegistry } from "../slots/registry";
import type { ClientServices } from "../types";
import { createApiService } from "./api";
import { createI18nService } from "./i18n";
import { createInstanceService } from "./instances";

export function createClientContext(registry: SlotRegistry): ClientServices {
  return {
    slots: registry,
    api: createApiService(),
    instances: createInstanceService(),
    i18n: createI18nService(),
    log: console,
  };
}
