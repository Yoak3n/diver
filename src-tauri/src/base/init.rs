use crate::base::cmd::*;
use crate::base::window::pet as pet_win;
use crate::base::window::schema::WindowType;
use tauri::{generate_handler, AppHandle, Builder, Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind, TimezoneStrategy};

pub fn generate_handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static
{
    generate_handler![
        get_sidecar_status,
        restart_sidecar,
        get_sidecar_url,
        list_shortcuts,
        set_shortcut,
        remove_shortcut,
        suspend_shortcuts,
        resume_shortcuts,
        list_plugins,
        set_plugin_enabled,
        toggle_plugin,
        get_plugin_paths,
        get_active_profile,
        preflight_plugins,
        switch_profile,
        install_profile_plugin,
        uninstall_profile_plugin,
        get_tts_config,
        set_tts_config,
        tts_list_voices,
        tts_list_models,
        tts_synthesize,
        is_pet_window_open,
        notify,
        get_window_startup_config,
        set_window_startup_config,
        get_mcp_config,
        save_mcp_config,
        get_pet_window_config,
        set_pet_size_percent,
        show_pet_window,
        hide_pet_window,
        toggle_pet_window,
        clamp_pet_window,
        move_pet_window,
        cancel_pet_move_animation,
        set_pet_dragging,
        get_cursor_screen_point,
        list_monitors,
        move_pet_to_monitor,
        start_pet_mouse_stream,
    ]
}

pub fn configure(builder: Builder<tauri::Wry>) -> Builder<tauri::Wry> {
    let builder = builder.plugin(tauri_plugin_opener::init());

    // 全局快捷键：统一 handler 分发（热插拔注册/注销见 base/shortcut.rs）。
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                crate::base::shortcut::ShortcutManager::global().handle(app, shortcut, event);
            })
            .build(),
    );

    // 原生通知：agent 主动消息 / 日程提醒到达时托盘通知（见 base/notify.rs）。
    let builder = builder.plugin(tauri_plugin_notification::init());

    let builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .targets([
                // 输出到控制台
                Target::new(TargetKind::Stdout),
                // 输出到前端控制台
                Target::new(TargetKind::Webview),
                // 输出到日志文件
                Target::new(TargetKind::Folder {
                    path: dirs::data_dir()
                        .unwrap_or_default()
                        .join("diver")
                        .join("logs"),
                    file_name: Some("app".into()),
                }),
            ])
            // 插件默认 UTC，会与本地时间差 8 小时；统一用系统本地时区
            .timezone_strategy(TimezoneStrategy::UseLocal)
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

        // 初始化 MCP 服务配置：迁移旧位置（如有）并写入默认配置，
        // 之后由设置面板「MCP 服务」页直接编辑，保存即热重载生效。
        crate::config::mcp::ensure_initial(app.handle());

        // companion profile：壳端启停插件写在 profiles/companion/cordis.patch.yml。
        crate::plugins::ensure_profile(app.handle());

        // 全局快捷键：按配置注册启用绑定（运行时热插拔由 base/shortcut.rs 负责）。
        crate::base::shortcut::ShortcutManager::global().init(app.handle());

        // 启动 Node sidecar（cos harness + companion bundle，agent 常驻）。
        let sidecar = crate::base::sidecar::SidecarManager::global();
        if !sidecar.start(app.handle()) {
            log::error!("sidecar 启动失败，请检查依赖安装状态");
        }

        // 启动窗口：按用户配置决定是否自动打开（默认全部打开）。
        // setup 在事件循环启动前执行：此处调用 build 是安全的例外路径。
        let startup = crate::config::window_startup::load_config(app.handle());
        log::info!(
            "[init] startup config: auto_open_main={} auto_open_pet={}",
            startup.auto_open_main,
            startup.auto_open_pet
        );
        if startup.auto_open_main {
            crate::base::window::manager::Manager::global()
                .show_window(WindowType::Main, None);
            log::info!("[init] main window show_window called");
        }

        // Live2D 桌宠：按配置缩放创建，位置恢复持久化值（无效则默认右下角）。
        if startup.auto_open_pet {
            if let Err(e) = pet_win::set_visible(app.handle(), true) {
                log::error!("[init] pet window show failed: {e}");
            } else {
                log::info!("[init] pet window shown");
            }
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
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let window = app_handle.get_webview_window(&label).unwrap();
                    let _ = window.hide();
                    // 状态缓存同步：X 关闭 = 隐藏。否则缓存停留 VisibleFocused，
                    // 托盘/桌宠的"打开主窗口"会误判为已可见而无操作（打不开）。
                    if let Some(wt) = WindowType::from_label(&label) {
                        crate::base::window::manager::Manager::global().update_window_state(
                            wt,
                            crate::base::window::schema::WindowState::Hidden,
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
                        crate::base::window::manager::Manager::global().update_window_state(
                            WindowType::Pet,
                            crate::base::window::schema::WindowState::NotExist,
                        );
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}
