// 实例清单状态与 CRUD（设置面板「实例」页）。
//
// 模块级单例：与其他设置页共享同一份清单状态。P0 边界——只登记不启动；
// 实例内设置（人格/模型/插件集）不在此编辑，仍走各 $COS_HOME/diver-settings.json。

import { ref } from "vue";
import {
  createInstance,
  deleteInstance,
  listInstances,
  tauriAvailable,
  updateInstance,
  type InstanceMeta,
} from "../tauri";

const instances = ref<InstanceMeta[]>([]);
const loading = ref(false);
const error = ref("");
const notice = ref("");

function fail(err: unknown, fallback: string): void {
  error.value = err instanceof Error ? err.message : String(err) || fallback;
}

/** 拉取实例清单（首次访问自动登记 default）。 */
async function refresh(): Promise<void> {
  if (!tauriAvailable()) {
    error.value = "当前不在 Tauri 环境中，无法读取实例清单";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    instances.value = await listInstances();
  } catch (err) {
    fail(err, "读取实例清单失败");
  } finally {
    loading.value = false;
  }
}

/** 登记新实例（命名可选，留空 = 未命名，之后由人格卡片回填），只登记不启动。 */
async function create(name?: string): Promise<boolean> {
  notice.value = "";
  error.value = "";
  try {
    const meta = await createInstance(name);
    instances.value = await listInstances();
    notice.value = `已登记实例 ${meta.id}；名字可在与它聊天后由人格卡片回填，也可稍后手动命名`;
    return true;
  } catch (err) {
    fail(err, "新建实例失败");
    return false;
  }
}

/** 改名（id 不可变；空名 = 清空回未命名）。 */
async function rename(id: string, name: string): Promise<boolean> {
  notice.value = "";
  error.value = "";
  try {
    await updateInstance(id, { name });
    instances.value = await listInstances();
    return true;
  } catch (err) {
    fail(err, "改名失败");
    return false;
  }
}

/** 启用开关（P1 起控制是否随应用启动，P0 只存储）。 */
async function toggle(id: string, enabled: boolean): Promise<boolean> {
  error.value = "";
  try {
    await updateInstance(id, { enabled });
    return true;
  } catch (err) {
    fail(err, "保存失败");
    await refresh();
    return false;
  }
}

/** 删除实例（default 命令层拒绝；数据目录清理随 P1 落地）。 */
async function remove(id: string): Promise<boolean> {
  notice.value = "";
  error.value = "";
  try {
    await deleteInstance(id);
    instances.value = await listInstances();
    return true;
  } catch (err) {
    fail(err, "删除失败");
    return false;
  }
}

export function useInstances() {
  return { instances, loading, error, notice, refresh, create, rename, toggle, remove };
}
