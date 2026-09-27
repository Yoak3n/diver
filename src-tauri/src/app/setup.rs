use crate::commands::*;
use crate::shell::window::pet as pet_win;
use crate::shell::window::schema::WindowType;
use tauri::{generate_handler, Builder, Emitter, Manager};
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
        get_service_token,
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
        tts_attach_player,
        tts_detach_player,
        tts_speak,
        tts_stop,
        tts_report_end,
        is_pet_window_open,
        pet_model_path,
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
        get_assistant_avatar,
        set_assistant_avatar,
        clear_assistant_avatar,
        get_mcp_config,
        save_mcp_config,
        list_instances,
        create_instance,
        list_groups,
        set_instance_pet_model,
        get_global_pet_model,
        set_global_pet_model,
        open_instance_pet,
        close_instance_pet,
        list_instance_pets,
        focus_instance_chat,
        update_instance,
        clear_instance_name,
        delete_instance,
        list_instance_runtimes,
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

    // 全局快捷键：统一 handler 分发（热插拔注册/注销见 app/shortcut.rs）。
    let builder = builder.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                crate::app::shortcut::ShortcutManager::global().handle(app, shortcut, event);
            })
            .build(),
    );

    // 原生通知：agent 主动消息 / 日程提醒到达时托盘通知（见 shell/notify.rs）。
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
        app.manage(crate::app::state::AppState::default());
        // TTS 播放队列（core 内单例句柄，commands 注入）
        app.manage(crate::core::tts::TtsPlayer::global());
        crate::app::handle::Handle::global().init(app.handle().clone());
        // shell 窗口管理：注入 AppHandle + 托盘回调（shell 不依赖 app 模块）。
        {
            let wm = crate::shell::window::manager::Manager::global();
            wm.init(app.handle().clone());
            wm.set_main_visible_listener(|visible| {
                crate::app::tray::update_menu_visible(visible);
            });
        }
        let _ = crate::app::tray::create_tray_icon(app, false);

        // P1-2 实例注册表：active 实例身份 + 启动清扫僵尸记录（pid 已死的崩溃残留）。
        let instance_id = crate::config::instances::active_instance_id(app.handle());
        let instance_name = crate::config::instances::list_instances(app.handle())
            .into_iter()
            .find(|i| i.id == instance_id)
            .and_then(|i| i.name);
        {
            let reg_dir = crate::config::instances::registry_dir(app.handle());
            let swept = crate::core::instance_registry::sweep_stale_at(&reg_dir);
            if !swept.is_empty() {
                log::info!(
                    "实例注册表清扫 {} 条僵尸记录（{:?}）",
                    swept.len(),
                    swept.iter().map(|r| r.id.clone()).collect::<Vec<_>>()
                );
            }
        }

        // 启动本地服务（SQLite 记忆后端等），端口注入 sidecar。
        // 通知 / presence 能力在 app 层包好闭包再注入，services 不依赖 shell/core。
        {
            let notify_app = app.handle().clone();
            let notify: crate::services::NotifyFn = std::sync::Arc::new(move |title, body| {
                crate::shell::notify::show(&notify_app, &title, &body);
            });
            let presence_dispatch: crate::services::PresenceDispatchFn =
                std::sync::Arc::new(|method, params| {
                    crate::core::presence::dispatch_rpc(method, params)
                });
            // 记忆双库路径按实例 id 派生（P1-1 双库 + P1-2 身份头路由）：
            // enabled 实例各一份私有库，无身份/未知回退 active 实例。
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| crate::config::config_dir(app.handle()));
            let instance_id = instance_id.clone();
            let mut memory_ids: Vec<String> = crate::config::instances::list_instances(app.handle())
                .into_iter()
                .filter(|i| i.enabled)
                .map(|i| i.id)
                .collect();
            if !memory_ids.contains(&instance_id) {
                memory_ids.push(instance_id.clone());
            }
            let memory_dbs: Vec<(String, crate::config::instances::MemoryPaths)> = memory_ids
                .iter()
                .map(|id| {
                    (
                        id.clone(),
                        crate::config::instances::memory_paths_for(&data_dir, id),
                    )
                })
                .collect();
            // 写回式回填：人格卡片名字 → 实例清单 name（权威源 = 卡片）。
            let on_card_name: crate::services::CardNameFn = {
                let app_handle = app.handle().clone();
                let backfill_id = instance_id.clone();
                std::sync::Arc::new(move |name| {
                    // 不变量：「清空回未命名」只能由用户在设置面板手动完成；
                    // 写回路径永不为空（双保险，与 services 层过滤一起兜住）。
                    if name.trim().is_empty() {
                        return;
                    }
                    if let Err(err) = crate::config::instances::update_instance(
                        &app_handle,
                        &backfill_id,
                        Some(&name),
                        None,
                    ) {
                        log::warn!("实例名写回失败（{backfill_id}）：{err}");
                    }
                })
            };
            // P1-2 注册中心查询：registry::list 读注册表文件（P2 消息路由寻址基础）。
            let registry_list: crate::services::RegistryListFn = {
                let dir = crate::config::instances::registry_dir(app.handle());
                std::sync::Arc::new(move || {
                    serde_json::to_value(crate::core::instance_registry::list_at(&dir))
                        .map_err(|e| e.to_string())
                })
            };
            match crate::services::start(
                app.handle(),
                crate::core::sidecar::service_token().to_string(),
                notify,
                presence_dispatch,
                memory_dbs,
                instance_id.clone(),
                on_card_name,
                registry_list,
                app.path()
                    .app_data_dir()
                    .expect("app_data_dir 可用"),
            ) {
                Some(port) => std::env::set_var("DIVER_MEMORY_PORT", port.to_string()),
                None => log::error!("本地服务启动失败，记忆功能不可用"),
            }
            // debug 形态把鉴权令牌落盘供本地脚本（scripts/*.mjs）自动读取；
            // release 不落盘（令牌只活在进程 env / 内存）。
            #[cfg(debug_assertions)]
            {
                if let Ok(dir) = app.path().app_data_dir() {
                    match std::fs::write(dir.join("service-token"), crate::core::sidecar::service_token())
                    {
                        Ok(()) => log::debug!("[init] service-token 已落盘（debug 形态）"),
                        Err(e) => log::warn!("[init] service-token 落盘失败: {e}"),
                    }
                }
            }
        }

        // 初始化 MCP 服务配置：迁移旧位置（如有）并写入默认配置，
        // 之后由设置面板「MCP 服务」页直接编辑，保存即热重载生效。
        crate::config::mcp::ensure_initial(app.handle());

        // companion profile：壳端启停插件写在 profiles/companion/cordis.patch.yml。
        crate::plugins::ensure_profile(app.handle());

        // sidecar 启动钩子：profile/布局/preflight 在 plugins 层组装后注入 core，
        // 保持 plugins ↔ core 零互引。
        {
            use crate::core::sidecar::{LaunchContext, LaunchHooks, PreflightStatus};
            let hooks = LaunchHooks {
                launch: std::sync::Arc::new(|app: &tauri::AppHandle| {
                    let profile = crate::plugins::active_profile(app);
                    let paths = crate::plugins::plugin_paths_for(app, &profile);
                    LaunchContext {
                        profile,
                        bundle_dir: paths.bundle_dir,
                        plugins_root: paths.plugins_root,
                    }
                }),
                preflight: std::sync::Arc::new(|app: &tauri::AppHandle| {
                    let r = crate::plugins::preflight(app);
                    PreflightStatus {
                        ok: r.ok,
                        profile: r.profile,
                        safe_mode: r.safe_mode,
                        problems: r.problems,
                        quarantined: r.quarantined,
                    }
                }),
                safe_profile_name: crate::plugins::SAFE_PROFILE.to_string(),
            };
            crate::core::sidecar::SidecarManager::global().set_hooks(hooks);
        }

        // P1-2 实例注册表定位注入 manager：就绪登记 / 退出注销。
        crate::core::sidecar::SidecarManager::global().set_registry_target(
            crate::core::instance_registry::RegistryTarget {
                dir: crate::config::instances::registry_dir(app.handle()),
                id: instance_id.clone(),
                name: instance_name.clone(),
            },
        );

        // 全局快捷键：按配置注册启用绑定（运行时热插拔由 app/shortcut.rs 负责）。
        crate::app::shortcut::ShortcutManager::global().init(app.handle());

        // 陪伴存在感：加载互动配置 + 启动 presence 日程调度（控制面在壳）。
        // 路径与通知闭包在 app 层注入，core 不摸 app/shell。
        {
            let cos_home = crate::config::cos_home(app.handle());
            let pet_cfg = crate::core::pet_interaction::load_config(&cos_home);
            crate::core::pet_interaction::apply_config(&pet_cfg);
            let notify_app = app.handle().clone();
            crate::core::presence_schedule::spawn_scheduler(cos_home, move |title, body| {
                crate::shell::notify::show(&notify_app, title, body);
            });
            crate::core::explore_policy::spawn_explore_scheduler();
        }

        // 总是先显示主窗口（首启准备遮罩盖在上面），再后台拉起 sidecar。
        let startup = crate::config::window_startup::load_config(app.handle());
        log::info!(
            "[init] startup config: auto_open_main={} auto_open_pet={}",
            startup.auto_open_main,
            startup.auto_open_pet
        );
        // 仅当用户要求自动打开，或仍需首启准备（解压 / Node）时弹出主窗口看进度。
        // 禁止用 last_progress().is_none() 兜底 —— 该值是进程内内存，每次启动都是
        // None，会恒真并旁路「启动时打开主窗口」配置。
        let bootstrap = crate::core::setup_progress::needs_bootstrap(app.handle());
        if startup.auto_open_main || bootstrap {
            crate::shell::window::manager::Manager::global()
                .show_window(WindowType::Main, None);
            log::info!(
                "[init] main window show_window called (auto_open_main={}, bootstrap={})",
                startup.auto_open_main,
                bootstrap
            );
        } else {
            log::info!(
                "[init] skip main window (auto_open_main=false, bootstrap=false)"
            );
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
                let sidecar = crate::core::sidecar::SidecarManager::global();
                crate::core::setup_progress::emit_progress(
                    &handle,
                    "start",
                    "正在启动助手…",
                    0.0,
                    false,
                );
                if sidecar.start(&handle2) {
                    // 就绪以 DIVER_READY / HTTP health 为准；这里只表示进程已拉起
                    crate::core::setup_progress::emit_progress(
                        &handle,
                        "start",
                        "正在启动助手…",
                        85.0,
                        false,
                    );
                    // P1-2 多实例拉起：active 之外的 enabled 实例顺序拉起
                    // （独立线程，不阻塞遮罩收起；顺序 = preflight 不竞态）。
                    let handle3 = handle.clone();
                    std::thread::spawn(move || {
                        crate::core::sidecar::Runtimes::global().start_enabled_extras(&handle3);
                    });
                    // 轮询 health：backend 就绪后主动收起遮罩（不单靠 stdout 里的 DIVER_READY）
                    let handle2 = handle.clone();
                    std::thread::spawn(move || {
                        let port = crate::core::sidecar::SidecarManager::global().port();
                        for i in 0..40 {
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            if http_health_ok(port) {
                                crate::core::setup_progress::emit_progress(
                                    &handle2,
                                    "ready",
                                    "就绪",
                                    100.0,
                                    true,
                                );
                                let _ = handle2.emit(
                                    "backend://ready",
                                    crate::core::sidecar::SidecarManager::global().status(),
                                );
                                return;
                            }
                            if i == 39 {
                                crate::core::setup_progress::emit_error(
                                    &handle2,
                                    "助手未就绪（HTTP 健康检查超时），请查看日志",
                                );
                            }
                        }
                    });
                } else {
                    log::error!("sidecar 启动失败，请检查依赖安装状态");
                    crate::core::setup_progress::emit_error(&handle, "助手启动失败，请查看日志");
                }
            });
        }

        log::info!("[probe] setup 完成，事件循环即将启动");
        Ok(())
    })
}
