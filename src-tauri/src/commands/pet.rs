//! 桌宠窗口 / 显示器 / 鼠标流 command。

use tauri::AppHandle;

use crate::shell::window::pet as pet_win;
use crate::config::pet_window::PetWindowConfig;

/// 桌宠窗口是否在线（朗读路由分流：在线时只允许桌宠播放，防双窗口叠音）。
#[tauri::command]
pub fn is_pet_window_open(app: AppHandle) -> bool {
    use tauri::Manager as _;
    app.get_webview_window(pet_win::PET_WINDOW_LABEL)
        .map(|w| w.is_visible().unwrap_or(true))
        .unwrap_or(false)
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
    crate::shell::cursor::cursor_screen_point()
}

/// 列出所有显示器（物理像素，相对虚拟屏幕原点）。
#[tauri::command]
pub fn list_monitors(app: AppHandle) -> Vec<serde_json::Value> {
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
pub fn move_pet_to_monitor(app: AppHandle, index: usize) -> bool {
    pet_win::move_to_monitor(&app, index).is_ok()
}

/// 启动/重绑桌宠全局鼠标流（点击穿透恢复）。
#[tauri::command]
pub fn start_pet_mouse_stream(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::app::state::AppState>,
) {
    state.pet_mouse.start(window);
}

/// 桌宠模型文件绝对路径（release：安装目录 resources/pet/models 明文文件，
/// 前端经 asset 协议读取；`rel` 形如 "Hiyori/Hiyori.model3.json"）。
#[tauri::command]
pub fn pet_model_path(app: AppHandle, rel: String) -> Result<String, String> {
    use tauri::Manager as _;
    let res = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法解析资源目录: {e}"))?;
    Ok(crate::core::pet_models::model_file(&res, &rel)?.to_string_lossy().into_owned())
}
