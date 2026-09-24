// 壳端插件 / profile / 预检 IPC。

import { invoke } from "./core";

/** 壳端插件信息（cos profile 启停）。 */
export interface PluginInfo {
  id: string;
  packageName: string;
  displayName: string;
  description: string;
  kind: string;
  enabled: boolean;
  toggleable: boolean;
  source: string;
  present: boolean;
  advisory?: string | null;
}

/** 列出 companion 插件。 */
export function listPlugins(): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("list_plugins");
}

/** 启停插件并重启 sidecar。 */
export function togglePluginAndRestart(id: string, enabled: boolean): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("toggle_plugin", { id, enabled });
}

/** 仅写启停状态，不重启。 */
export function setPluginEnabled(id: string, enabled: boolean): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("set_plugin_enabled", { id, enabled });
}

/** 预检报告（P3）。 */
export interface PreflightReport {
  ok: boolean;
  profile: string;
  safeMode: boolean;
  problems: string[];
  quarantined?: string | null;
  bundleDir: string;
  pluginsRoot: string;
  profileDir: string;
  harnessDir: string;
}

/** 当前激活 profile。 */
export function getActiveProfile(): Promise<string> {
  return invoke<string>("get_active_profile");
}

/** 启动预检。 */
export function preflightPlugins(): Promise<PreflightReport> {
  return invoke<PreflightReport>("preflight_plugins");
}

/** 切换 profile（companion / safe）并重启 sidecar。 */
export function switchProfile(profile: "companion" | "safe"): Promise<PreflightReport> {
  return invoke<PreflightReport>("switch_profile", { profile });
}

/** 安装 profile 插件（file: / git / npm）。 */
export function installProfilePlugin(spec: string, restart = true): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("install_profile_plugin", { spec, restart });
}

/** 卸载 profile 插件（internal 会被拒绝）。 */
export function uninstallProfilePlugin(id: string, restart = true): Promise<PluginInfo[]> {
  return invoke<PluginInfo[]>("uninstall_profile_plugin", { id, restart });
}
