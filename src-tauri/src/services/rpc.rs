//! 统一 JSON-RPC 入口（`POST /rpc`）。
//!
//! 请求：`{ "method": "...", "params": { ... } }`
//! 响应：`{ "ok": true, "data": ... }` / `{ "ok": false, "error": "..." }`
//!
//! 未来新增服务时，在 [dispatch] 中按 method 前缀路由到对应服务模块即可。

use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{memory, ServiceState};

#[derive(Deserialize)]
pub struct RpcRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

pub async fn dispatch(State(state): State<ServiceState>, Json(request): Json<RpcRequest>) -> Json<Value> {
    match route(&state, &request.method, &request.params) {
        Ok(data) => Json(json!({ "ok": true, "data": data })),
        Err(error) => Json(json!({ "ok": false, "error": error })),
    }
}

fn route(state: &ServiceState, method: &str, params: &Value) -> Result<Value, String> {
    // 未来新增服务时，按前缀分流到对应模块。
    memory::dispatch(&state.memory_db, method, params)
}
