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

/// 查询全局鼠标在屏幕上的物理坐标（用于桌宠窗口点击穿透判定）。
/// 返回 (x, y)；获取失败时返回 None。
#[tauri::command]
pub fn get_cursor_screen_point() -> Option<(i32, i32)> {
    use mouse_position::mouse_position::Mouse;
    match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Some((x, y)),
        Mouse::Error => None,
    }
}

/// 列出所有显示器（用于「把桌宠转移到指定屏幕」）。
/// 返回 [{ name, x, y, width, height }]（物理像素坐标，相对虚拟屏幕原点）。
#[tauri::command]
pub fn list_monitors(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    app.available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let p = *m.position();
            let s = *m.size();
            serde_json::json!({
                "name": m.name().cloned().unwrap_or_default(),
                "x": p.x,
                "y": p.y,
                "width": s.width,
                "height": s.height,
            })
        })
        .collect()
}

/// 把桌宠窗口转移到指定显示器（贴其工作区右下角，多屏安全）。
/// 用显示器坐标直接 set_position，不依赖拖动事件，无跨屏闪动。
#[tauri::command]
pub fn move_pet_to_monitor(app: tauri::AppHandle, index: usize) -> bool {
    use tauri::Manager as _;
    let monitors = app.available_monitors().unwrap_or_default();
    let Some(monitor) = monitors.get(index) else {
        return false;
    };
    let area = *monitor.work_area();
    let Some(window) = app.get_webview_window(crate::base::window::schema::WindowType::Pet.label()) else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    // 贴该显示器工作区右下角（留 24px 边距），如右下角定位初始逻辑
    let x = (area.position.x + area.size.width as i32 - size.width as i32 - 24)
        .max(area.position.x);
    let y = (area.position.y + area.size.height as i32 - size.height as i32 - 24)
        .max(area.position.y);
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    true
}
