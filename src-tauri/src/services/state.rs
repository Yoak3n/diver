//! 本地服务共享状态与回调类型。

use std::sync::{Arc, Mutex};

use serde_json::Value;

/// 原生通知回调（app 层包一层 `shell::notify::show` 后注入）。
pub type NotifyFn = Arc<dyn Fn(String, String) + Send + Sync>;

/// presence RPC 分发回调（app 层包一层 `core::presence::dispatch_rpc` 后注入）。
pub type PresenceDispatchFn = Arc<dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync>;

/// 所有本地服务共享的状态；新增服务时在这里扩展字段。
#[derive(Clone)]
pub struct ServiceState {
    pub memory_db: Arc<Mutex<diver_memory::db::MemoryDb>>,
    pub notify: NotifyFn,
    pub presence_dispatch: PresenceDispatchFn,
}
