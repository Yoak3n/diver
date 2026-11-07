// 模型目录异步补拉：`/api/settings` 只回快照，上游 `/models` 放到首屏之后。
//
// 设置页的提供商卡片只依赖 settingsInfo；模型下拉可以晚几秒填充。这里把
// 「进入设置页 / 保存配置 / 自定义身份变更」触发的目录刷新收敛到一处，
// 做节流与 in-flight 去重，避免重复打上游。

import { getModelCatalog } from "../api";
import { applyModelCatalog, catalogLoading } from "./settings-state";

/** 非强制刷新的最短间隔：openSettings 会被页面挂载 / 侧栏事件 / 重启轮询多次触发。 */
const CATALOG_REFRESH_MIN_INTERVAL_MS = 3000;
let catalogRefreshAt = 0;
let catalogRefresh: Promise<void> | null = null;

/**
 * 补拉模型目录（目录 advisory，失败保留上一份列表）。
 * `force` 用于配置/自定义身份刚变更后的补拉。
 */
export async function refreshModelCatalog(force = false): Promise<void> {
  if (catalogRefresh !== null) {
    // 非强制：复用进行中的一次；强制：等它结束后再补一轮——在途请求可能早于
    // 刚注册的自定义 provider 发起，直接复用会漏掉新 provider 的模型。
    if (!force) return catalogRefresh;
    await catalogRefresh;
  }
  if (!force && Date.now() - catalogRefreshAt < CATALOG_REFRESH_MIN_INTERVAL_MS) return;
  catalogRefreshAt = Date.now();
  catalogLoading.value = true;
  const run = (async () => {
    try {
      const { models } = await getModelCatalog();
      applyModelCatalog(models);
    } catch {
      /* ignore */
    } finally {
      catalogLoading.value = false;
      catalogRefresh = null;
    }
  })();
  catalogRefresh = run;
  return run;
}
