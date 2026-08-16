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
        show_main_window,
        get_window_startup_config,
        set_window_startup_config,
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

        // 启动 Node sidecar（dsh 框架 + 陪伴 bundle，agent 常驻）。
        let sidecar = crate::base::sidecar::SidecarManager::global();
        if !sidecar.start(app.handle()) {
            log::error!("sidecar 启动失败，请检查依赖安装状态");
        }

        // 启动窗口：按用户配置决定是否自动打开（默认全部打开）。
        let startup = crate::config::window_startup::load_config(app.handle());
        if startup.auto_open_main {
            crate::base::window::manager::Manager::global()
                .show_window(crate::base::window::schema::WindowType::Main, None);
        }

        // Live2D 桌宠：常驻桌面（透明/置顶）。
        if startup.auto_open_pet {
            crate::base::window::manager::Manager::global()
                .show_window(crate::base::window::schema::WindowType::Pet, None);
        }

        Ok(())
    })
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
