pub mod app;
pub mod commands;
pub mod config;
pub mod core;
pub mod plugins;
pub mod services;
pub mod shell;

pub use crate::shell::window::manager::Manager as WM;


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = app::setup::configure(tauri::Builder::default());
    // 单例保护（P1-3 可选化）：缺省注册——第二个实例启动时经命名管道通知已有
    // 实例（回调在已有实例进程中执行），然后自身退出，防止并发写同一实例的
    // session 日志 / 记忆库。`DIVER_MULTI_INSTANCE` 设置（非空且非 0）时跳过，
    // 允许多壳并行（开发 / 测试；多壳共享实例清单与记忆库，风险自负）。
    let builder = if crate::config::multi_instance_enabled() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            use crate::shell::window::schema::{WindowOperationResult, WindowType};
            // 已有实例：把主聊天窗口带到前台（桌宠窗口常态常驻，无需处理）
            let _ = matches!(
                WM::global().show_window(WindowType::Main, None),
                WindowOperationResult::Shown | WindowOperationResult::Created
            );
        }))
    };
    builder
        .invoke_handler(app::setup::generate_handlers())
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(app::events::app_event_handle);
}
