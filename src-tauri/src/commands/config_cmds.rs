//! 启动窗口 / MCP 等配置读写 command。

use tauri::AppHandle;

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

/// 读取 MCP 服务配置（设置面板「MCP 服务」页直接编辑的配置文件）。
#[tauri::command]
pub fn get_mcp_config(app: AppHandle) -> crate::config::mcp::McpConfig {
    crate::config::mcp::load_config(&app)
}

/// 保存 MCP 服务配置，返回是否成功。
#[tauri::command]
pub fn save_mcp_config(app: AppHandle, config: crate::config::mcp::McpConfig) -> bool {
    crate::config::mcp::save_config(&app, &config)
}
