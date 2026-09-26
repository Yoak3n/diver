//! 系统级 command：sidecar 状态、启动进度、通知。

use tauri::AppHandle;

use crate::core::sidecar::{SidecarManager, SidecarStatus};

/// 查询 sidecar 状态。
#[tauri::command]
pub fn get_sidecar_status() -> SidecarStatus {
    SidecarManager::global().status()
}

/// 首启/启动准备进度（WebView 晚挂载时回放，避免遮罩卡 0%）。
#[tauri::command]
pub fn get_setup_progress() -> Option<crate::core::setup_progress::SetupProgress> {
    // 启动时序探针：前端挂载后首次 IPC 到达时刻（只打一次）。
    use std::sync::atomic::{AtomicBool, Ordering};
    static FIRST_IPC: AtomicBool = AtomicBool::new(false);
    if !FIRST_IPC.swap(true, Ordering::Relaxed) {
        log::info!("[probe] 首个前端 IPC 到达（get_setup_progress）");
    }
    crate::core::setup_progress::last_progress()
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

/// 本地服务鉴权令牌（P2-1 / BUG-002）：前端 `fetch` / `EventSource` 附着后
/// 才能访问 sidecar backend `/api`（`/api/health` 与静态 UI 除外）。
#[tauri::command]
pub fn get_service_token() -> String {
    crate::core::sidecar::service_token().to_string()
}

/// 弹出原生通知（托盘通知；前端可直接调用，Node 侧经 /rpc notify::show）。
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    crate::shell::notify::show(&app, &title, &body);
}
