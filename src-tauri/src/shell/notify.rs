//! 原生通知（Windows 托盘通知）：agent 主动消息 / 日程提醒到达时弹出。
//!
//! 触发路径：
//! - Node 侧（`@diver/presence` 等）经本地 `/rpc` 调 `notify::show`；
//! - 前端经 invoke `notify` 命令直接触发；
//! - 壳内部（如快捷键/托盘）也可直接调 [show]。

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// 弹出一条原生通知。
///
/// Windows 下无需请求权限（`request_permission` 恒 Granted）；失败只记日志，
/// 不影响调用方（通知是可丢事件）。
pub fn show(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
    {
        log::warn!("[notify] 显示通知失败: {e}");
    } else {
        log::info!("[notify] {title}: {body}");
    }
}
