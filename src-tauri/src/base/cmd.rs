// Tauri command handlers — Diver 应用命令。

use tauri::AppHandle;

use crate::base::sidecar::{SidecarManager, SidecarStatus};
use crate::base::tts;
use crate::base::window::pet as pet_win;
use crate::config::pet_window::PetWindowConfig;
use crate::plugins::PluginInfo;

/// 查询 sidecar 状态。
#[tauri::command]
pub fn get_sidecar_status() -> SidecarStatus {
    SidecarManager::global().status()
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
    crate::plugins::toggle_plugin(&app, &id, enabled)
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
    crate::plugins::switch_profile_and_restart(&app, &profile)
}

/// 安装 profile 插件（pnpm add + 登记），可选重启。
#[tauri::command]
pub fn install_profile_plugin(
    app: AppHandle,
    spec: String,
    restart: Option<bool>,
) -> Result<Vec<PluginInfo>, String> {
    crate::plugins::install::install_profile_plugin(&app, &spec, restart.unwrap_or(true))
}

/// 卸载 profile 插件（internal 拒绝）。
#[tauri::command]
pub fn uninstall_profile_plugin(
    app: AppHandle,
    id: String,
    restart: Option<bool>,
) -> Result<Vec<PluginInfo>, String> {
    crate::plugins::install::uninstall_profile_plugin(&app, &id, restart.unwrap_or(true))
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

/// 读取桌宠窗口配置（位置 + 缩放百分比）。
#[tauri::command]
pub fn get_pet_window_config(app: AppHandle) -> PetWindowConfig {
    pet_win::get_config(&app)
}

/// 设置桌宠缩放百分比并立即应用到窗口。
#[tauri::command]
pub fn set_pet_size_percent(app: AppHandle, percent: f64) -> Result<PetWindowConfig, String> {
    pet_win::set_size_percent(&app, percent)
}

/// 显示桌宠窗口（async：create 必须离开主线程）。
#[tauri::command]
pub async fn show_pet_window(app: AppHandle) -> Result<(), String> {
    pet_win::set_visible(&app, true)
}

/// 收起桌宠窗口 = 销毁实例（async：destroy 禁止在主线程）。
#[tauri::command]
pub async fn hide_pet_window(app: AppHandle) -> Result<(), String> {
    pet_win::set_visible(&app, false)
}

/// 切换桌宠显隐，返回切换后是否可见。
#[tauri::command]
pub async fn toggle_pet_window(app: AppHandle) -> Result<bool, String> {
    pet_win::toggle(&app)
}

/// 桌宠软限位：夹到最近可见显示器工作区（拖动结束后调用，不在 Moved 里跑）。
#[tauri::command]
pub fn clamp_pet_window(app: AppHandle) {
    pet_win::ensure_visible(&app)
}

/// 按物理像素增量移动桌宠，并夹进最近显示器（对齐 DSH `move_pet_window`）。
/// `delta_x/y = 0` 时等价于软恢复；需要挪动时带 ease-out 过渡。
#[tauri::command]
pub fn move_pet_window(app: AppHandle, delta_x: i32, delta_y: i32) -> Result<(), String> {
    pet_win::move_by_delta(&app, delta_x, delta_y)
}

/// 取消进行中的桌宠位置过渡动画。
#[tauri::command]
pub fn cancel_pet_move_animation() {
    pet_win::cancel_position_animation()
}

/// 标记桌宠「系统拖动会话」开/关。
/// beginDrag 时 true（禁止归位动画）；Moved 停歇归位前 false（允许 ease-out 过渡）。
#[tauri::command]
pub fn set_pet_dragging(active: bool) {
    pet_win::set_dragging(active)
}

/// 查询全局鼠标在屏幕上的物理坐标（穿透判定兜底；主路径走 device-mouse-move 事件）。
#[tauri::command]
pub fn get_cursor_screen_point() -> Option<(i32, i32)> {
    use mouse_position::mouse_position::Mouse;
    match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Some((x, y)),
        Mouse::Error => None,
    }
}

/// 列出所有显示器（物理像素，相对虚拟屏幕原点）。
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

/// 把桌宠窗口转移到指定显示器（贴其工作区右下角，并持久化位置）。
#[tauri::command]
pub fn move_pet_to_monitor(app: tauri::AppHandle, index: usize) -> bool {
    pet_win::move_to_monitor(&app, index).is_ok()
}

/// 启动/重绑桌宠全局鼠标流（点击穿透恢复）。
#[tauri::command]
pub fn start_pet_mouse_stream(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::base::state::AppState>,
) {
    state.pet_mouse.start(window);
}
