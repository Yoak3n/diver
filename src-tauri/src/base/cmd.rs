// Tauri command handlers — Diver 应用命令。

use tauri::AppHandle;

use crate::base::sidecar::{SidecarManager, SidecarStatus};
use crate::base::tts;

/// 查询 sidecar 状态。
#[tauri::command]
pub fn get_sidecar_status() -> SidecarStatus {
    SidecarManager::global().status()
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

/// 本地 TTS 朗读文本。
#[tauri::command]
pub fn speak(app: AppHandle, text: String, voice: Option<String>) -> bool {
    tts::speak(&app, &text, voice.as_deref())
}

/// 列出系统已安装的 TTS 语音。
#[tauri::command]
pub fn list_voices(app: AppHandle) -> Vec<String> {
    tts::list_voices(&app)
}

/// 读取启动窗口配置。
#[tauri::command]
pub fn get_window_startup_config(app: AppHandle) -> crate::config::window_startup::WindowStartupConfig {
    crate::config::window_startup::load_config(&app)
}

/// 保存启动窗口配置。
#[tauri::command]
pub fn set_window_startup_config(
    app: AppHandle,
    config: crate::config::window_startup::WindowStartupConfig,
) -> bool {
    crate::config::window_startup::save_config(&app, &config)
}
