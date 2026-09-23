use tauri::{AppHandle, Manager, RunEvent};

use crate::shell::window::pet as pet_win;
use crate::shell::window::schema::WindowType;

pub fn app_event_handle(app_handle: &AppHandle, event: RunEvent) {
    match event {
        tauri::RunEvent::Ready | tauri::RunEvent::Resumed => {}
        tauri::RunEvent::Exit => {
            // 应用退出时停止 sidecar（agent 随之结束，记忆保留在磁盘）。
            crate::core::sidecar::SidecarManager::global().stop();
        }
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::WindowEvent { label, event, .. } => {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let window = app_handle.get_webview_window(&label).unwrap();
                    let _ = window.hide();
                    // 状态缓存同步：X 关闭 = 隐藏。否则缓存停留 VisibleFocused，
                    // 托盘/桌宠的"打开主窗口"会误判为已可见而无操作（打不开）。
                    if let Some(wt) = WindowType::from_label(&label) {
                        crate::shell::window::manager::Manager::global().update_window_state(
                            wt,
                            crate::shell::window::schema::WindowState::Hidden,
                        );
                    }
                }
                // 桌宠跨窗口/跨屏拖动（对齐 DSH）：
                // Moved **只落盘 + 记时间戳**，绝不在拖动过程中 set_position。
                // 时间戳供 move_by_delta/animation 判定「系统拖动是否仍活跃」，
                // 避免归位动画与 startDragging 双写坐标 → 跨屏重影闪烁。
                tauri::WindowEvent::Moved(_) => {
                    if WindowType::from_label(&label) == Some(WindowType::Pet) {
                        pet_win::note_window_moved();
                        if let Some(window) = app_handle.get_webview_window(&label) {
                            pet_win::save_window_position(&window);
                        }
                    }
                }
                tauri::WindowEvent::Focused(true) => {}
                tauri::WindowEvent::Focused(false) => {}
                tauri::WindowEvent::Destroyed => {
                    if WindowType::from_label(&label) == Some(WindowType::Pet) {
                        crate::shell::window::manager::Manager::global().update_window_state(
                            WindowType::Pet,
                            crate::shell::window::schema::WindowState::NotExist,
                        );
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}
