//! 实例注册表的 RPC handler：`registry::*` → 注入的查询闭包。
//!
//! 注册中心查询（P1-2）：注册表文件读写在 `core::instance_registry`，
//! services 不依赖 core，app 层注入闭包。

use serde_json::Value;

use super::ServiceState;

pub fn dispatch(state: &ServiceState, method: &str) -> Result<Value, String> {
    match method {
        // 注册项 JSON 数组：[{ id, name, pid, port, startedAt }]。
        "registry::list" => (state.registry_list)(),
        _ => Err(format!("unknown registry method: {method}")),
    }
}
