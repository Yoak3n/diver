//! `group::*` RPC 分发与参数解析。

use serde_json::Value;

use crate::services::grep::RpcFailure;
use crate::services::ServiceState;

use super::list::list;
use super::{ops, say};

/// `group::*` 分发（P2-4）。
pub async fn dispatch(
    state: &ServiceState,
    instance_id: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<Value, RpcFailure> {
    let sender = instance_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| state.memory.fallback());
    match method {
        "group::list" => list(state, sender).map_err(RpcFailure::new),
        "group::say" => say::say(state, sender, params).await.map_err(RpcFailure::new),
        "group::create" => ops::create(state, sender, params).await.map_err(RpcFailure::new),
        "group::invite" => ops::invite(state, sender, params).await.map_err(RpcFailure::new),
        "group::respond" => ops::respond(state, sender, params).await.map_err(RpcFailure::new),
        other => Err(RpcFailure::new(format!("未知 group 方法：{other}"))),
    }
}

pub(super) fn text_param(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}
