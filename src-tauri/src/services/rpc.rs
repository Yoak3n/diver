//! 统一 JSON-RPC 入口（`POST /rpc`）。
//!
//! 请求：`{ "method": "...", "params": { ... } }`
//! 响应：`{ "ok": true, "data": ... }` / `{ "ok": false, "error": "...", "code"?: "..." }`
//!
//! 按 method 前缀分流：`grep::*` → grep 服务（无状态，spawn_blocking），其余 → memory。

use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{grep, groups, memory, notify, peer, presence, registry, screenshot, ServiceState};

#[derive(Deserialize)]
pub struct RpcRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

pub async fn dispatch(
    State(state): State<ServiceState>,
    headers: axum::http::HeaderMap,
    Json(request): Json<RpcRequest>,
) -> Json<Value> {
    // P1-2 记忆路由身份头：无头/未知 id 在 MemoryPool 内回退 active 实例。
    let instance = headers
        .get("x-diver-instance")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    match route(&state, instance.as_deref(), &request.method, &request.params).await {
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

async fn route(
    state: &ServiceState,
    instance_id: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<Value, grep::RpcFailure> {
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
    if method.starts_with("notify::") {
        // 通知是壳能力：Node 主动消息/日程提醒到达时弹系统通知（闭包由 start 注入）。
        return notify::dispatch(state, method, params).map_err(grep::RpcFailure::new);
    }
    if method.starts_with("presence::") {
        // 存在感回压 / 裁决：控制面在壳（companion-presence-fsm.md）。
        // 分发闭包由 app 注入（services 不依赖 core）。
        return presence::dispatch(state, method, params).map_err(grep::RpcFailure::new);
    }
    if method.starts_with("screenshot::") {
        // 截屏是阻塞 GDI：跑在 blocking 线程池（同 grep）。
        let method = method.to_string();
        let params = params.clone();
        return tokio::task::spawn_blocking(move || screenshot::dispatch(&method, &params))
            .await
            .map_err(|join_err| grep::RpcFailure::new(format!("screenshot task failed: {join_err}")))?;
    }
    if method.starts_with("registry::") {
        // 实例注册中心查询（P1-2）：读注册表文件；闭包由 app 注入。
        return registry::dispatch(state, method).map_err(grep::RpcFailure::new);
    }
    if method.starts_with("peer::") {
        // 互实例消息（P2-2）：壳 = 消息路由，按身份头盖章来源后投递对端 /api/inbox。
        return peer::dispatch(state, instance_id, method, params).await;
    }
    if method.starts_with("group::") {
        // 群组消息与群务（P2-4）：群 = 壳层实体，成员解析后经 peer 路由投递。
        return groups::dispatch(state, instance_id, method, params).await;
    }
    // memory 方法保持无前缀（零迁移）；错误无 code。
    memory::dispatch(state, instance_id, method, params).map_err(grep::RpcFailure::new)
}
