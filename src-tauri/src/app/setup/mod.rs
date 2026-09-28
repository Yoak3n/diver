//! 应用组装与生命周期：Builder 插件装配 + setup 钩子（服务 / sidecar / 窗口初始化）。
//!
//! 分层：handlers.rs command 注册表 | service.rs 本地服务闭包装配
//! | sidecar_boot.rs 后台拉起与就绪轮询；本文件只做装配主干与生命周期顺序。

mod handlers;
mod service;
mod sidecar_boot;

use tauri::{Builder, Manager};
use tauri_plugin_log::{Target, TargetKind, TimezoneStrategy};

pub use handlers::generate_handlers;

pub fn configure(builder: Builder<tauri::Wry>) -> Builder<tauri::Wry> {
    let builder = builder.plugin(tauri_plugin_opener::init());

    // 全局快捷键：统一 handler 分发（热插拔注册/注销见 app/shortcut/）。
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

        // 启动本地服务（SQLite 记忆后端等），端口注入 sidecar；
        // 通知 / presence 等能力在 app 层包好闭包再注入（见 service.rs）。
        service::start_local_services(app.handle(), &instance_id);

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

        // 全局快捷键：按配置注册启用绑定（运行时热插拔由 app/shortcut/ 负责）。
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

            // 相位迁移广播：thinking 进出驱动桌宠思考表现（payload 带实例 id，
            // 桌宠窗口按绑定实例过滤；经典宠跟随 active 标记）。
            use tauri::Emitter;
            let phase_app = app.handle().clone();
            crate::core::presence::PresenceHandle::set_phase_sink(std::sync::Arc::new(
                move |instance: &str, prev: &str, next: &str| {
                    let active = crate::core::presence::resolve_instance_id(None) == instance;
                    let _ = phase_app.emit(
                        "presence://phase",
                        serde_json::json!({
                            "instance": instance,
                            "prev": prev,
                            "phase": next,
                            "active": active,
                        }),
                    );
                },
            ));
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
                .show_window(crate::shell::window::schema::WindowType::Main, None);
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
            if let Err(e) = crate::shell::window::pet::set_visible(app.handle(), true) {
                log::error!("[init] pet window show failed: {e}");
            } else {
                log::info!("[init] pet window shown");
            }
        }

        // 后台：解压依赖 + 解析/下载 Node + 启动 sidecar + 轮询 health（见 sidecar_boot.rs）。
        sidecar_boot::spawn_sidecar_background(app.handle().clone());

        log::info!("[probe] setup 完成，事件循环即将启动");
        Ok(())
    })
}
