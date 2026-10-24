// 实例清单状态与 CRUD（设置面板「实例」页）。
//
// 模块级单例：与其他设置页共享同一份清单状态。P0 边界——只登记不启动；
// 实例内设置（人格/模型/插件集）不在此编辑，仍走各 $COS_HOME/diver-settings.json。

import { ref } from "vue";
import {
  clearInstanceName,
  createInstance,
  deleteInstance,
  getOnebotOwner,
  listInstances,
  setInstanceAutoRead,
  setInstanceTtsProfile,
  setOnebotOwner,
  tauriAvailable,
  updateInstance,
  type InstanceMeta,
  type InstanceTtsProfile,
} from "../tauri";

const instances = ref<InstanceMeta[]>([]);
const loading = ref(false);
const error = ref("");
const notice = ref("");
/** QQ（OneBot）归属实例 id：全局单选，null = 未绑定（旧「配置即归属」行为）。 */
const onebotOwner = ref<string | null>(null);

function fail(err: unknown, fallback: string): void {
  error.value = err instanceof Error ? err.message : String(err) || fallback;
}

/** 拉取实例清单（首次访问自动登记 default）与 QQ 归属绑定。 */
async function refresh(): Promise<void> {
  if (!tauriAvailable()) {
    error.value = "当前不在 Tauri 环境中，无法读取实例清单";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    instances.value = await listInstances();
    onebotOwner.value = await getOnebotOwner();
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

/** 改名（id 不可变；空名 = 不修改，清空走 clearName）。 */
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

/** 清空名字（仅此入口）：双写清空人格卡片 + 清单，真回到未命名、命名流程可重来。 */
async function clearName(id: string): Promise<boolean> {
  notice.value = "";
  error.value = "";
  try {
    await clearInstanceName(id);
    instances.value = await listInstances();
    notice.value = "已清空名字，回到未命名；下次与它聊天时可重新命名";
    return true;
  } catch (err) {
    fail(err, "清空名字失败");
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

/** 每实例自动朗读开关（自动朗读 = 全局 TTS 总开关 AND 本开关）。 */
async function setAutoRead(id: string, autoRead: boolean): Promise<boolean> {
  error.value = "";
  try {
    const meta = await setInstanceAutoRead(id, autoRead);
    const inst = instances.value.find((x) => x.id === id);
    if (inst) inst.autoRead = meta.autoRead;
    return true;
  } catch (err) {
    fail(err, "保存失败");
    await refresh();
    return false;
  }
}

/** 每实例音色档案（null = 跟随全局 TTS 配置；自定义即整组钉定）。 */
async function setTtsProfile(id: string, tts: InstanceTtsProfile | null): Promise<boolean> {
  error.value = "";
  try {
    const meta = await setInstanceTtsProfile(id, tts);
    const inst = instances.value.find((x) => x.id === id);
    if (inst) inst.tts = meta.tts ?? null;
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
    // 被删实例若是 QQ 归属，壳层已自动解绑；此处同步回显
    onebotOwner.value = await getOnebotOwner();
    return true;
  } catch (err) {
    fail(err, "删除失败");
    return false;
  }
}

/**
 * 绑定 / 解绑 QQ 归属实例（全局单选）：勾选即取代旧归属；
 * 取消勾选仅当本实例是归属时解绑（不误伤他人的绑定）。
 * 生效需重启 sidecar（env 下发），提示见 notice。
 */
async function setQqOwner(id: string, on: boolean): Promise<boolean> {
  if (!on && onebotOwner.value !== id) return true;
  error.value = "";
  notice.value = "";
  try {
    await setOnebotOwner(on ? id : null);
    onebotOwner.value = on ? id : null;
    notice.value = on
      ? `已绑定实例 ${id} 接 QQ：其余实例的 OneBot 插件休眠，重启应用后生效（连接配置见设置「QQ 接入」页）`
      : "已解除 QQ 归属：回到未绑定行为（配置了 wsUrl 的实例可连接），重启应用后生效";
    return true;
  } catch (err) {
    fail(err, "保存失败");
    await refresh();
    return false;
  }
}

export function useInstances() {
  return {
    instances,
    loading,
    error,
    notice,
    onebotOwner,
    refresh,
    create,
    rename,
    clearName,
    toggle,
    setAutoRead,
    setTtsProfile,
    setQqOwner,
    remove,
  };
}
