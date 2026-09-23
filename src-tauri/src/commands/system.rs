//! 系统级 command：sidecar 状态、启动进度、通知。

use tauri::AppHandle;

use crate::base::sidecar::{SidecarManager, SidecarStatus};

/// 查询 sidecar 状态。
#[tauri::command]
pub fn get_sidecar_status() -> SidecarStatus {
    SidecarManager::global().status()
}

/// 首启/启动准备进度（WebView 晚挂载时回放，避免遮罩卡 0%）。
#[tauri::command]
pub fn get_setup_progress() -> Option<crate::base::setup_progress::SetupProgress> {
    crate::base::setup_progress::last_progress()
}

/// 重启 sidecar（停止后重新拉起）。
#[tauri::command]
pub fn restart_sidecar(app: AppHandle) -> bool {
    SidecarManager::global().restart(&app)
}

/// 获取 sidecar 的 API 根地址（供前端展示/调试）。
#[tauri::command]
pub fn get_sidecar_url() -> String {
    SidecarManager::global().api_base_url()
}

/// 弹出原生通知（托盘通知；前端可直接调用，Node 侧经 /rpc notify::show）。
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    crate::base::notify::show(&app, &title, &body);
}
