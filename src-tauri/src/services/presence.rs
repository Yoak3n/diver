//! presence 服务的 RPC handler：`presence::*` → 注入的 dispatch 闭包。
//!
//! Node sidecar 经 `/rpc` 回压 busy/聊天活动；裁决后的 inject 仍由壳发起。
//! 实际分发逻辑由 app 注入（`ServiceState::presence_dispatch`），services 不依赖 core。

use serde_json::Value;

use super::ServiceState;

pub fn dispatch(state: &ServiceState, method: &str, params: &Value) -> Result<Value, String> {
    (state.presence_dispatch)(method, params)
}
