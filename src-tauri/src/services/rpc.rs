//! 统一 JSON-RPC 入口（`POST /rpc`）。
//!
//! 请求：`{ "method": "...", "params": { ... } }`
//! 响应：`{ "ok": true, "data": ... }` / `{ "ok": false, "error": "...", "code"?: "..." }`
//!
//! 按 method 前缀分流：`grep::*` → grep 服务（无状态，spawn_blocking），其余 → memory。

use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{grep, memory, ServiceState};

#[derive(Deserialize)]
pub struct RpcRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

pub async fn dispatch(State(state): State<ServiceState>, Json(request): Json<RpcRequest>) -> Json<Value> {
    match route(&state, &request.method, &request.params).await {
        Ok(data) => Json(json!({ "ok": true, "data": data })),
        Err(failure) => {
            let mut body = json!({ "ok": false, "error": failure.message });
            if let Some(code) = failure.code {
                body["code"] = json!(code);
            }
            Json(body)
        }
    }
}

async fn route(state: &ServiceState, method: &str, params: &Value) -> Result<Value, grep::RpcFailure> {
    if method.starts_with("grep::") {
        // grep 搜索是阻塞 IO/CPU：跑在 blocking 线程池，避免卡 async 线程。
        // workdir 用 COS_HOME/workspace（与 Node 侧 basic-tools 的默认一致）。
        let workdir = std::env::var("COS_HOME")
            .map(|home| std::path::Path::new(&home).join("workspace"))
            .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default())
            .to_string_lossy()
            .into_owned();
        let method = method.to_string();
        let params = params.clone();
        return tokio::task::spawn_blocking(move || grep::dispatch(&method, &params, &workdir))
            .await
            .map_err(|join_err| grep::RpcFailure::new(format!("grep task failed: {join_err}")))?
    }
    // memory 方法保持无前缀（零迁移）；错误无 code。
    memory::dispatch(&state.memory_db, method, params).map_err(grep::RpcFailure::new)
}
