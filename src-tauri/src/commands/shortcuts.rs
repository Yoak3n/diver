//! 全局快捷键 command。

use tauri::AppHandle;

use crate::base::shortcut::ShortcutManager;
use crate::config::shortcuts::ShortcutBinding;

/// 列出全局快捷键绑定（含启用状态）。
#[tauri::command]
pub fn list_shortcuts(app: AppHandle) -> Vec<ShortcutBinding> {
    crate::config::shortcuts::load_config(&app).bindings
}

/// 热插拔：新增/更新单个快捷键绑定（写配置 + 运行时注册/注销）。
#[tauri::command]
pub fn set_shortcut(
    app: AppHandle,
    binding: ShortcutBinding,
) -> Result<Vec<ShortcutBinding>, String> {
    ShortcutManager::global().set_binding(&app, binding)
}

/// 热插拔：移除快捷键绑定（写配置 + 运行时注销）。
#[tauri::command]
pub fn remove_shortcut(app: AppHandle, id: String) -> Result<Vec<ShortcutBinding>, String> {
    ShortcutManager::global().remove_binding(&app, id)
}

/// 录制组合键前调用：挂起全部全局热键，避免 OS 吞掉 keydown。
#[tauri::command]
pub fn suspend_shortcuts(app: AppHandle) -> Result<(), String> {
    ShortcutManager::global().suspend(&app)
}

/// 录制组合键结束后调用：按配置恢复全局热键。
#[tauri::command]
pub fn resume_shortcuts(app: AppHandle) -> Result<(), String> {
    ShortcutManager::global().resume(&app)
}
