// 实例清单 IPC（壳层元配置 app_config_dir/instances.json）。
// P0 边界：只登记不启动；CRUD 走 Tauri invoke，不走 backend HTTP
// （实例必须在任何 sidecar 存在之前就能定义）。

import { invoke } from "./core";

/** 实例元数据。实例内设置（人格/模型/插件集）不在此：走各 $COS_HOME/diver-settings.json。 */
export interface InstanceMeta {
  /** 不可变实例 id，路径安全字符集 [a-z0-9-] */
  id: string;
  /** 展示名称，可改 */
  name: string;
  /** 是否随应用启动（P1 起生效，P0 只存储） */
  enabled: boolean;
  /** 头像留位 */
  avatar: string | null;
  /** 登记时间（Unix 秒） */
  createdAt: number;
}

/** 列出全部实例（首次访问自动登记 default）。 */
export function listInstances(): Promise<InstanceMeta[]> {
  return invoke<InstanceMeta[]>("list_instances");
}

/** 登记新实例：名称自动生成 id，只登记不启动。 */
export function createInstance(name: string): Promise<InstanceMeta> {
  return invoke<InstanceMeta>("create_instance", { name });
}

/** 改名 / 启用开关（id 不可变）。 */
export function updateInstance(
  id: string,
  patch: { name?: string; enabled?: boolean },
): Promise<InstanceMeta> {
  return invoke<InstanceMeta>("update_instance", {
    id,
    name: patch.name ?? null,
    enabled: patch.enabled ?? null,
  });
}

/** 删除实例（default 不可删；数据目录清理随 P1 落地）。 */
export function deleteInstance(id: string): Promise<void> {
  return invoke<void>("delete_instance", { id });
}
