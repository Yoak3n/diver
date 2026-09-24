//! 插件与 profile 相关 command。

use tauri::AppHandle;

use crate::plugins::PluginInfo;

/// 注入给 plugins 的 sidecar 重启回调（plugins 不依赖 core）。
fn restart_sidecar(app: &AppHandle) -> bool {
    crate::core::sidecar::SidecarManager::global().restart(app)
}

/// 列出 companion 插件。
#[tauri::command]
pub fn list_plugins(app: AppHandle) -> Vec<PluginInfo> {
    crate::plugins::list_plugins(&app)
}

/// 启停插件（写 profile 补丁，不重启）。
#[tauri::command]
pub fn set_plugin_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Vec<PluginInfo>, String> {
    crate::plugins::set_plugin_enabled(&app, &id, enabled)
}

/// 启停插件并重启 sidecar。
#[tauri::command]
pub fn toggle_plugin(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Vec<PluginInfo>, String> {
    crate::plugins::toggle_plugin(&app, &id, enabled, &restart_sidecar)
}

/// 插件布局诊断路径。
#[tauri::command]
pub fn get_plugin_paths(app: AppHandle) -> serde_json::Value {
    crate::plugins::plugin_paths_json(&app)
}

/// 当前激活 profile（companion / safe）。
#[tauri::command]
pub fn get_active_profile(app: AppHandle) -> String {
    crate::plugins::active_profile(&app)
}

/// 启动预检（布局 + profile 补丁）。
#[tauri::command]
pub fn preflight_plugins(app: AppHandle) -> crate::plugins::PreflightReport {
    crate::plugins::ensure_profile(&app);
    crate::plugins::preflight(&app)
}

/// 切换 profile（companion / safe）并重启 sidecar。
#[tauri::command]
pub fn switch_profile(
    app: AppHandle,
    profile: String,
) -> Result<crate::plugins::PreflightReport, String> {
    crate::plugins::switch_profile_and_restart(&app, &profile, &restart_sidecar)
}

/// 安装 profile 插件（pnpm add + 登记），可选重启。
#[tauri::command]
pub fn install_profile_plugin(
    app: AppHandle,
    spec: String,
    restart: Option<bool>,
) -> Result<Vec<PluginInfo>, String> {
    crate::plugins::install::install_profile_plugin(
        &app,
        &spec,
        restart.unwrap_or(true),
        &restart_sidecar,
    )
}

/// 卸载 profile 插件（internal 拒绝）。
#[tauri::command]
pub fn uninstall_profile_plugin(
    app: AppHandle,
    id: String,
    restart: Option<bool>,
) -> Result<Vec<PluginInfo>, String> {
    crate::plugins::uninstall_profile_plugin(
        &app,
        &id,
        restart.unwrap_or(true),
        &restart_sidecar,
    )
}
