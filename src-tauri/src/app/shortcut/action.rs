//! 快捷键触发动作分发与冲突提示。

use tauri::AppHandle;

use crate::config::shortcuts::ShortcutAction;
use crate::shell::window::manager::Manager as WM;
use crate::shell::window::schema::WindowType;

/// 按动作分发到窗口（快捷键 handler 同步调用，使用壳内全局管理器）。
pub(super) fn dispatch_action(action: ShortcutAction) {
    match action {
        ShortcutAction::ShowMain => {
            let _ = WM::global().show_window(WindowType::Main, None);
        }
        ShortcutAction::ToggleMain => {
            let _ = WM::global().toggle_window(WindowType::Main);
        }
    }
}

/// 冲突提示（P1-3 占位策略）：被占用的绑定跳过注册，通知用户改绑或释放。
pub(super) fn notify_skipped(app: &AppHandle, skipped: &[String]) {
    let list = skipped.join("、");
    crate::shell::notify::show(
        app,
        "全局快捷键未注册",
        &format!("{list} 已被其他程序占用，本实例跳过注册（可在设置中改绑）"),
    );
}
