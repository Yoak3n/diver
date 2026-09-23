//! presence 服务的 RPC handler：`presence::*` → 壳内 CompanionPresence。
//!
//! Node sidecar 经 `/rpc` 回压 busy/聊天活动；裁决后的 inject 仍由壳发起。

use serde_json::Value;

pub fn dispatch(method: &str, params: &Value) -> Result<Value, String> {
    crate::core::presence::dispatch_rpc(method, params)
}
