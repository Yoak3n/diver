//! notify 服务的 RPC handler：`notify::show` → 壳发原生通知。
//!
//! 这是 Node 侧主动消息 → 壳通知的通道（Node→Rust 经 `/rpc`，见 channels.md）。
//! 通知能力经 [ServiceState] 注入的闭包提供，本层禁止 use `crate::app` / `crate::shell`。

use serde_json::Value;

use super::ServiceState;

/// `notify::show`：弹出原生通知。
///
/// 参数：`{ "title": "...", "body": "..." }`；均缺省时用占位文案。
pub fn dispatch(state: &ServiceState, method: &str, params: &Value) -> Result<Value, String> {
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
            (state.notify)(title.to_string(), body.to_string());
            Ok(Value::Null)
        }
        _ => Err(format!("未知 notify 方法: {method}")),
    }
}
