//! notify 服务的 RPC handler：`notify::show` → 壳发原生通知。
//!
//! 这是 Node 侧主动消息 → 壳通知的通道（Node→Rust 经 `/rpc`，见 channels.md）。

use serde_json::Value;

/// `notify::show`：弹出原生通知。
///
/// 参数：`{ "title": "...", "body": "..." }`；均缺省时用占位文案。
pub fn dispatch(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "notify::ping" => {
            // 连通性探测：不弹通知（native_status 用这个，绝不能拿 show 当探测）。
            Ok(Value::Null)
        }
        "notify::show" => {
            let title = params
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("Diver");
            let body = params
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let app = crate::base::handle::Handle::global()
                .app_handle()
                .ok_or_else(|| "app handle 未初始化".to_string())?;
            crate::base::notify::show(&app, title, body);
            Ok(Value::Null)
        }
        _ => Err(format!("未知 notify 方法: {method}")),
    }
}
