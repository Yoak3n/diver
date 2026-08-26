use tauri::{AppHandle, Builder, Manager, RunEvent, generate_handler};
use tauri_plugin_log::{Target, TargetKind};
use crate::base::cmd::*;


pub fn generate_handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static{
    generate_handler![
        get_sidecar_status,
        restart_sidecar,
        get_sidecar_url,
        speak,
        list_voices,
        get_window_startup_config,
        set_window_startup_config,
        get_mcp_config,
        save_mcp_config,
        get_cursor_screen_point,
        list_monitors,
        move_pet_to_monitor,
    ]
}


pub fn configure(builder: Builder<tauri::Wry>) -> Builder<tauri::Wry> {
    let builder = builder.plugin(tauri_plugin_opener::init());

    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .targets([
                // 输出到控制台
                Target::new(TargetKind::Stdout),
                // 输出到前端控制台
                Target::new(TargetKind::Webview),
                // 输出到日志文件
                Target::new(TargetKind::Folder {
                    path: dirs::data_dir().unwrap_or_default().join("diver").join("logs"),
                    file_name: Some("app".into()),
                }),
            ])
            .level(log::LevelFilter::Info)
            .build(),
    );

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = {
        use tauri_plugin_autostart::MacosLauncher;
        builder.plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
    };

    builder.setup(|app| {
        app.manage(crate::base::state::AppState::default());
        crate::base::handle::Handle::global().init(app.handle().clone());
        let _ = crate::base::tray::create_tray_icon(app, false);

        // 启动本地服务（SQLite 记忆后端等），端口注入 sidecar。
        match crate::services::start(app.handle()) {
            Some(port) => std::env::set_var("DIVER_MEMORY_PORT", port.to_string()),
            None => log::error!("本地服务启动失败，记忆功能不可用"),
        }

        // 初始化 MCP 服务配置：首次运行写入默认配置（work-review 示例），
        // 之后由设置面板「MCP 服务」页直接编辑，保存即热重载生效。
        crate::config::mcp::ensure_initial(app.handle());

        // 启动 Node sidecar（dsh 框架 + 陪伴 bundle，agent 常驻）。
        let sidecar = crate::base::sidecar::SidecarManager::global();
        if !sidecar.start(app.handle()) {
            log::error!("sidecar 启动失败，请检查依赖安装状态");
        }

        // 启动窗口：按用户配置决定是否自动打开（默认全部打开）。
        let startup = crate::config::window_startup::load_config(app.handle());
        log::info!(
            "[init] startup config: auto_open_main={} auto_open_pet={}",
            startup.auto_open_main,
            startup.auto_open_pet
        );
        if startup.auto_open_main {
            crate::base::window::manager::Manager::global()
                .show_window(crate::base::window::schema::WindowType::Main, None);
            log::info!("[init] main window show_window called");
        }

        // Live2D 桌宠：常驻桌面（透明/置顶）。
        if startup.auto_open_pet {
            crate::base::window::manager::Manager::global()
                .show_window(crate::base::window::schema::WindowType::Pet, None);
            log::info!("[init] pet window show_window called");
        }

        Ok(())
    })
}

/// 桌宠窗口实时限位：把窗口 clamp 在"大部分面积所在显示器"的工作区内。
/// 用 current_monitor（面积判定）：窗口大部分进入副屏才切换显示器边界，
/// 跨屏时平滑；set_position 只在位移超过 CLAMP_EPS 时触发，避免边界竞争闪动。
fn clamp_pet_window_to_screen(app_handle: &tauri::AppHandle, label: &str) {
    const CLAMP_EPS: i32 = 1; // 位移阈值（px），小于它不 set_position，防抖动
    let Some(window) = app_handle.get_webview_window(label) else {
        return;
    };
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let win_w = size.width as i32;
    let win_h = size.height as i32;

    // 大部分面积所在显示器（跨屏时稳定，交界处不来回切换）
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let area = *monitor.work_area();

    // 若窗口比工作区还大，直接对齐到左上角（避免 clamp 反转）
    let max_x = (area.position.x + area.size.width as i32 - win_w).max(area.position.x);
    let max_y = (area.position.y + area.size.height as i32 - win_h).max(area.position.y);

    let nx = pos.x.clamp(area.position.x, max_x);
    let ny = pos.y.clamp(area.position.y, max_y);
    if (nx - pos.x).abs() > CLAMP_EPS || (ny - pos.y).abs() > CLAMP_EPS {
        let _ = window.set_position(tauri::PhysicalPosition::new(nx, ny));
    }
}

pub fn app_event_handle(app_handle: &AppHandle, event: RunEvent) {
    match event {
        tauri::RunEvent::Ready | tauri::RunEvent::Resumed => {}
        tauri::RunEvent::Exit => {
            // 应用退出时停止 sidecar（agent 随之结束，记忆保留在磁盘）。
            crate::base::sidecar::SidecarManager::global().stop();
        }
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        tauri::RunEvent::WindowEvent { label, event, .. } => {
            // if label == "main" {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let window = app_handle.get_webview_window(&label).unwrap();
                    let _ = window.hide();
                    // 状态缓存同步：X 关闭 = 隐藏。否则缓存停留 VisibleFocused，
                    // 托盘/桌宠的"打开主窗口"会误判为已可见而无操作（打不开）。
                    if let Some(wt) = crate::base::window::schema::WindowType::from_label(&label) {
                        crate::base::window::manager::Manager::global()
                            .update_window_state(wt, crate::base::window::schema::WindowState::Hidden);
                    }
                }
                // 桌宠实时限位：拖动时窗口始终被限制在"大部分面积所在显示器"
                // 的工作区内（多屏安全）。用 current_monitor（面积判定）而非
                // monitor_from_point（中心点），跨屏时窗口大部分进入副屏才切换
                // 边界，避免在屏幕交界处来回抖动。set_position 只在位移超过
                // 阈值时触发，避免与系统拖动的边界竞争产生闪动。
                tauri::WindowEvent::Moved(_) => {
                    if let Some(wt) = crate::base::window::schema::WindowType::from_label(&label) {
                        if wt == crate::base::window::schema::WindowType::Pet {
                            clamp_pet_window_to_screen(app_handle, &label);
                        }
                    }
                }
                tauri::WindowEvent::Focused(true) => {}
                tauri::WindowEvent::Focused(false) => {}
                tauri::WindowEvent::Destroyed => {}
                _ => {}
            }
            // }
        }
        _ => {}
    }
}
