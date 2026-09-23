pub mod base;
pub mod commands;
pub mod config;
pub mod plugins;
pub mod services;

use base::init;
pub use base::window::manager::Manager as WM;


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init::configure(tauri::Builder::default())
        // 单例检查：第二个实例启动时经命名管道通知已有实例（回调在已有实例
        // 进程中执行），然后自身退出。防止多实例并发写同一 session 日志等事故。
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {
            use crate::base::window::schema::{WindowOperationResult, WindowType};
            // 已有实例：把主聊天窗口带到前台（桌宠窗口常态常驻，无需处理）
            let _ = matches!(
                WM::global().show_window(WindowType::Main, None),
                WindowOperationResult::Shown | WindowOperationResult::Created
            );
        }))
        .invoke_handler(init::generate_handlers())
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(base::init::app_event_handle);
}