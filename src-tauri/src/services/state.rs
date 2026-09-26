//! 本地服务共享状态与回调类型。

use std::sync::{Arc, Mutex};

use serde_json::Value;

/// 原生通知回调（app 层包一层 `shell::notify::show` 后注入）。
pub type NotifyFn = Arc<dyn Fn(String, String) + Send + Sync>;

/// presence RPC 分发回调（app 层包一层 `core::presence::dispatch_rpc` 后注入）。
pub type PresenceDispatchFn = Arc<dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync>;

/// 人格卡片名字变更回调（app 层包一层「写回实例清单 name」后注入）。
/// 写回式回填（P1-1）：人格卡片是名字权威源，实例清单只是回显。
pub type CardNameFn = Arc<dyn Fn(String) + Send + Sync>;

/// 实例注册表查询回调（app 层包一层 `core::instance_registry::list_at` 后注入，
/// P1-2 注册中心查询，返回注册项 JSON 数组）。
pub type RegistryListFn = Arc<dyn Fn() -> Result<Value, String> + Send + Sync>;

/// 所有本地服务共享的状态；新增服务时在这里扩展字段。
#[derive(Clone)]
pub struct ServiceState {
    /// 记忆双库（P1-1）：私有库 + 共享库；`shared: true` 的事件写共享库，读合并。
    pub memory_db: Arc<Mutex<diver_memory::db::DualDb>>,
    pub notify: NotifyFn,
    pub presence_dispatch: PresenceDispatchFn,
    /// 人格卡片更新后把名字写回实例清单（写回式回填）。
    pub on_card_name: CardNameFn,
    /// 实例注册表查询（`registry::list`）。
    pub registry_list: RegistryListFn,
}
