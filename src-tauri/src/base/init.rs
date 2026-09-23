use crate::commands::*;
use crate::base::window::pet as pet_win;
use crate::base::window::schema::WindowType;
use tauri::{generate_handler, AppHandle, Builder, Emitter, Manager, RunEvent};
use tauri_plugin_log::{Target, TargetKind, TimezoneStrategy};

/// 无子进程 HTTP 健康探测（避免 curl/黑窗）。
fn http_health_ok(port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
    let req = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf).unwrap_or(0);
    let text = String::from_utf8_lossy(&buf[..n]);
    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")
}

pub fn generate_handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static
{
    generate_handler![
        get_sidecar_status,
        get_setup_progress,
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
        tts_synthesize_stream,
        is_pet_window_open,
        notify,
        presence_phase,
        presence_snapshot,
        presence_event,
        presence_request_inject,
        presence_explore_snapshot,
        presence_explore_trigger,
        presence_explore_cancel,
        set_pet_interaction_config,
        get_pet_interaction_config,
        pet_gesture_event,
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

        // 陪伴存在感：加载互动配置 + 启动 presence 日程调度（控制面在壳）。
        {
            let pet_cfg = crate::base::pet_interaction::load_config();
            crate::base::pet_interaction::apply_config(&pet_cfg);
            crate::base::presence_schedule::spawn_scheduler();
            crate::base::explore_policy::spawn_explore_scheduler();
        }

        // 总是先显示主窗口（首启准备遮罩盖在上面），再后台拉起 sidecar。
        let startup = crate::config::window_startup::load_config(app.handle());
        log::info!(
            "[init] startup config: auto_open_main={} auto_open_pet={}",
            startup.auto_open_main,
            startup.auto_open_pet
        );
        // 首启/未就绪时强制出主窗口，避免只看到遮罩或空壳。
        if startup.auto_open_main || crate::base::setup_progress::last_progress().is_none() {
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

        // 后台：解压依赖 + 解析/下载 Node + 启动 sidecar（不阻塞 setup / 窗口显示）。
        {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let handle2 = handle.clone();
                let sidecar = crate::base::sidecar::SidecarManager::global();
                crate::base::setup_progress::emit_progress(
                    &handle,
                    "start",
                    "正在启动助手…",
                    0.0,
                    false,
                );
                if sidecar.start(&handle2) {
                    // 就绪以 DIVER_READY / HTTP health 为准；这里只表示进程已拉起
                    crate::base::setup_progress::emit_progress(
                        &handle,
                        "start",
                        "正在启动助手…",
                        85.0,
                        false,
                    );
                    // 轮询 health：backend 就绪后主动收起遮罩（不单靠 stdout 里的 DIVER_READY）
                    let handle2 = handle.clone();
                    std::thread::spawn(move || {
                        let port = crate::base::sidecar::SidecarManager::global().port();
                        for i in 0..40 {
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            if http_health_ok(port) {
                                crate::base::setup_progress::emit_progress(
                                    &handle2,
                                    "ready",
                                    "就绪",
                                    100.0,
                                    true,
                                );
                                let _ = handle2.emit(
                                    "backend://ready",
                                    crate::base::sidecar::SidecarManager::global().status(),
                                );
                                return;
                            }
                            if i == 39 {
                                crate::base::setup_progress::emit_error(
                                    &handle2,
                                    "助手未就绪（HTTP 健康检查超时），请查看日志",
                                );
                            }
                        }
                    });
                } else {
                    log::error!("sidecar 启动失败，请检查依赖安装状态");
                    crate::base::setup_progress::emit_error(&handle, "助手启动失败，请查看日志");
                }
            });
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
