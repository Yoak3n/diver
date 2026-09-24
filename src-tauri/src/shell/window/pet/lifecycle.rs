//! 桌宠窗口生命周期：创建 / 显隐切换（隐藏 = 销毁）。

use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow};

use super::super::manager::Manager as WM;
use super::super::schema::{WindowOperationResult, WindowState, WindowType};
use super::window::PET_WINDOW_LABEL;

/// 确保桌宠窗口存在：不存在则按配置创建并定位；已存在则复用。
///
/// **必须**从 async command / setup 调用，禁止主线程同步调用（build 需事件循环回包）。
pub fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        return Ok(window);
    }
    let result = WM::global().show_window(WindowType::Pet, None);
    match result {
        WindowOperationResult::Created
        | WindowOperationResult::Shown
        | WindowOperationResult::NoAction
        | WindowOperationResult::Hidden => app
            .get_webview_window(PET_WINDOW_LABEL)
            .ok_or_else(|| "PET_WINDOW_CREATE_FAILED".to_string()),
        WindowOperationResult::Failed => Err("PET_WINDOW_CREATE_FAILED".to_string()),
    }
}

/// 显示或收起桌宠。**隐藏 = 销毁窗口实例**。
///
/// 供 async command 调用：本函数在异步运行时线程执行，create/destroy 均安全。
pub fn set_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    if !visible {
        if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
            window
                .destroy()
                .map_err(|e| format!("PET_WINDOW_DESTROY_FAILED: {e}"))?;
        }
        WM::global().update_window_state(WindowType::Pet, WindowState::NotExist);
        return Ok(());
    }
    let window = ensure_window(app)?;
    let _ = window.show();
    // 桌宠常态不抢焦点：仅 show，不 set_focus。
    WM::global().update_window_state(WindowType::Pet, WindowState::VisibleFocused);
    Ok(())
}

/// 切换桌宠显隐，返回切换后是否可见。
pub fn toggle(app: &AppHandle) -> Result<bool, String> {
    let exists = app.get_webview_window(PET_WINDOW_LABEL).is_some();
    set_visible(app, !exists)?;
    Ok(!exists)
}

/// create 后短暂让出，便于事件循环完成窗口注册。
pub fn brief_yield() {
    std::thread::sleep(Duration::from_millis(10));
}
