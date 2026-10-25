// 插件 / profile / native 域端点（阶段 1 通道收敛：均走 backend HTTP，active 实例）。

import { json } from "./base";

export interface PluginInfo {
  id: string;
  packageName: string;
  displayName: string;
  description: string;
  kind: "internal" | "profile";
  enabled: boolean;
  toggleable: boolean;
  source: string;
  present: boolean;
  advisory?: string | null;
}

export interface PluginsResponse {
  activeProfile: string;
  plugins: PluginInfo[];
}

export interface ProfileInfo {
  activeProfile: string;
  bundleDir?: string;
  pluginsRoot?: string;
  profileDir: string;
}

export interface NativeStatus {
  configured: boolean;
  url: string | null;
  methods: Array<{ method: string; service: string; description: string }>;
  probes: Array<{ method: string; ok: boolean; detail: string }>;
  activeProfile: string;
}

export function listPluginsApi(instanceId?: string): Promise<PluginsResponse> {
  return json("/plugins", undefined, instanceId);
}

export function togglePluginApi(
  id: string,
  enabled: boolean,
  restart = true,
  instanceId?: string,
): Promise<PluginsResponse & { restart: boolean }> {
  return json(
    "/plugins/toggle",
    {
      method: "POST",
      body: JSON.stringify({ id, enabled, restart }),
    },
    instanceId,
  );
}

export function installProfilePluginApi(
  spec: string,
  restart = true,
  instanceId?: string,
): Promise<PluginsResponse & { restart: boolean }> {
  return json(
    "/plugins/install",
    {
      method: "POST",
      body: JSON.stringify({ spec, restart }),
    },
    instanceId,
  );
}

export function uninstallProfilePluginApi(
  id: string,
  restart = true,
  instanceId?: string,
): Promise<PluginsResponse & { restart: boolean }> {
  return json(
    "/plugins/uninstall",
    {
      method: "POST",
      body: JSON.stringify({ id, restart }),
    },
    instanceId,
  );
}

export interface PluginConfigFieldView {
  key: string;
  label: string;
  type?: "text" | "password" | "number" | "boolean" | "select";
  secret?: boolean;
  required?: boolean;
  description?: string;
  /** 可选分组标题：同 section 的字段渲染在同一块。 */
  section?: string;
  options?: Array<{ value: string; label: string }>;
  default?: string | number | boolean;
  value?: string;
  configured: boolean;
}

export interface PluginConfigView {
  id: string;
  packageName: string;
  title?: string;
  hasConfig: boolean;
  fields: PluginConfigFieldView[];
  /** 配置由独立设置页维护时的入口（产品层描述，前端不写死映射）。 */
  page?: { tab: string; label: string };
}

/** 插件配置读面（缺省 active 实例；传 instanceId 时直连该实例的 backend）。 */
export function getPluginConfigsApi(instanceId?: string): Promise<{ plugins: PluginConfigView[] }> {
  return json("/plugins/config", undefined, instanceId);
}

/** 保存插件配置（缺省 active 实例；传 instanceId 时写入该实例的 profile patch）。 */
export function savePluginConfigApi(
  id: string,
  values: Record<string, string | number | boolean | null>,
  instanceId?: string,
): Promise<{ ok: true; config: Record<string, unknown> }> {
  return json(
    "/plugins/config",
    {
      method: "POST",
      body: JSON.stringify({ id, values }),
    },
    instanceId,
  );
}

export function getProfileApi(): Promise<ProfileInfo> {
  return json("/profile");
}

export function switchProfileApi(
  profile: "companion" | "safe",
  restart = true,
  instanceId?: string,
): Promise<{ activeProfile: string; restart: boolean }> {
  return json(
    "/profile",
    {
      method: "POST",
      body: JSON.stringify({ profile, restart }),
    },
    instanceId,
  );
}

export function getNativeStatusApi(instanceId?: string): Promise<NativeStatus> {
  return json("/native/status", undefined, instanceId);
}
