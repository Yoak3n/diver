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

export function listPluginsApi(): Promise<PluginsResponse> {
  return json("/plugins");
}

export function togglePluginApi(
  id: string,
  enabled: boolean,
  restart = true,
): Promise<PluginsResponse & { restart: boolean }> {
  return json("/plugins/toggle", {
    method: "POST",
    body: JSON.stringify({ id, enabled, restart }),
  });
}

export function installProfilePluginApi(
  spec: string,
  restart = true,
): Promise<PluginsResponse & { restart: boolean }> {
  return json("/plugins/install", {
    method: "POST",
    body: JSON.stringify({ spec, restart }),
  });
}

export function uninstallProfilePluginApi(
  id: string,
  restart = true,
): Promise<PluginsResponse & { restart: boolean }> {
  return json("/plugins/uninstall", {
    method: "POST",
    body: JSON.stringify({ id, restart }),
  });
}

export interface PluginConfigFieldView {
  key: string;
  label: string;
  type?: "text" | "password" | "number" | "boolean" | "select";
  secret?: boolean;
  required?: boolean;
  description?: string;
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
}

export function getPluginConfigsApi(): Promise<{ plugins: PluginConfigView[] }> {
  return json("/api/plugins/config");
}

export function savePluginConfigApi(
  id: string,
  values: Record<string, string | number | boolean | null>,
): Promise<{ ok: true; config: Record<string, unknown> }> {
  return json("/api/plugins/config", {
    method: "POST",
    body: JSON.stringify({ id, values }),
  });
}

export function getProfileApi(): Promise<ProfileInfo> {
  return json("/profile");
}

export function switchProfileApi(
  profile: "companion" | "safe",
  restart = true,
): Promise<{ activeProfile: string; restart: boolean }> {
  return json("/profile", {
    method: "POST",
    body: JSON.stringify({ profile, restart }),
  });
}

export function getNativeStatusApi(): Promise<NativeStatus> {
  return json("/native/status");
}
