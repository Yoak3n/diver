// 实例清单 IPC（壳层元配置 app_config_dir/instances.json）。
// P0 边界：只登记不启动；CRUD 走 Tauri invoke，不走 backend HTTP
// （实例必须在任何 sidecar 存在之前就能定义）。

import { invoke } from "./core";

/** 实例元数据。实例内设置（人格/模型/插件集）不在此：走各 $COS_HOME/diver-settings.json。 */
export interface InstanceMeta {
  /** 不可变实例 id，路径安全字符集 [a-z0-9-] */
  id: string;
  /** 展示名称；null = 未命名（名字通常由用户与其聊天后经人格卡片回填） */
  name: string | null;
  /** 是否随应用启动（P1 起生效，P0 只存储） */
  enabled: boolean;
  /** 头像留位 */
  avatar: string | null;
  /** 每实例桌宠模型 id（P2-5）；null = 跟随全局模型选择 */
  petModel: string | null;
  /** 该实例回复是否自动朗读（自动朗读 = 全局 TTS 总开关 AND 本开关；群聊不朗读） */
  autoRead: boolean;
  /** 登记时间（Unix 秒） */
  createdAt: number;
}

/** 列出全部实例（首次访问自动登记 default，未命名）。 */
export function listInstances(): Promise<InstanceMeta[]> {
  return invoke<InstanceMeta[]>("list_instances");
}

/** 登记新实例：命名可选（留空 = 未命名），id 自动生成，只登记不启动。 */
export function createInstance(name?: string): Promise<InstanceMeta> {
  return invoke<InstanceMeta>("create_instance", { name: name?.trim() || null });
}

/** 改名 / 启用开关（id 不可变；name 空串/缺省 = 不修改；清空走 clearInstanceName）。 */
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

/** 设置每实例自动朗读开关（自动朗读 = 全局 TTS 总开关 AND 本开关）。 */
export function setInstanceAutoRead(id: string, autoRead: boolean): Promise<InstanceMeta> {
  return invoke<InstanceMeta>("set_instance_auto_read", { id, autoRead });
}

/** 清空名字（仅设置面板手动）：双写清空人格卡片 + 清单，真回到未命名。 */
export function clearInstanceName(id: string): Promise<InstanceMeta> {
  return invoke<InstanceMeta>("clear_instance_name", { id });
}

/** 删除实例（default 不可删；数据目录清理随 P1 落地）。 */
export function deleteInstance(id: string): Promise<void> {
  return invoke<void>("delete_instance", { id });
}

/** 运行时实例行（P2-3，注册表就绪行）：只含正在运行的 sidecar。 */
export interface InstanceRuntime {
  id: string;
  name: string | null;
  pid: number;
  port: number;
  startedAt: number;
}

/** 运行时就绪实例（注册表）；未启动的实例不在其中，前端与清单合并渲染。 */
export function listInstanceRuntimes(): Promise<InstanceRuntime[]> {
  return invoke<InstanceRuntime[]>("list_instance_runtimes");
}
