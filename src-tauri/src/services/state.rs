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

/// 记忆路由（P1-2 身份头路由）：`X-Diver-Instance` → 实例私有 DualDb。
///
/// 每实例一份私有库 + 共用共享库（P1-1 双库）；无身份 / 未知 id 回退 active
/// 实例（不带头的调用方保持旧行为，兼容单实例调试工具）。
#[derive(Clone)]
pub struct MemoryPool {
    dbs: std::collections::HashMap<String, Arc<Mutex<diver_memory::db::DualDb>>>,
    fallback: String,
}

impl MemoryPool {
    pub fn new(fallback: impl Into<String>) -> Self {
        Self {
            dbs: std::collections::HashMap::new(),
            fallback: fallback.into(),
        }
    }

    pub fn insert(&mut self, id: impl Into<String>, db: diver_memory::db::DualDb) {
        self.dbs.insert(id.into(), Arc::new(Mutex::new(db)));
    }

    /// active 实例 id（无身份头调用方的回退目标，P2-2 发送方缺省同此）。
    pub fn fallback(&self) -> &str {
        &self.fallback
    }

    pub fn contains(&self, id: &str) -> bool {
        self.dbs.contains_key(id)
    }

    /// 解析实例身份 → 对应 DualDb；无头/未知 id 回退 active 实例。
    pub fn resolve(
        &self,
        instance_id: Option<&str>,
    ) -> Result<Arc<Mutex<diver_memory::db::DualDb>>, String> {
        let id = instance_id.map(str::trim).filter(|s| !s.is_empty());
        if let Some(id) = id {
            if let Some(db) = self.dbs.get(id) {
                return Ok(db.clone());
            }
            log::warn!("记忆路由：未知实例身份「{id}」，回退 active 实例库");
        }
        self.dbs
            .get(&self.fallback)
            .cloned()
            .ok_or_else(|| "memory db unavailable".to_string())
    }
}

/// 所有本地服务共享的状态；新增服务时在这里扩展字段。
#[derive(Clone)]
pub struct ServiceState {
    /// 记忆双库路由（P1-2）：身份头 → 实例私有 DualDb，无头回退 active。
    pub memory: MemoryPool,
    /// 本地服务鉴权令牌（P2-1）：出站对端投递（P2-2 `peer::send`）同样携带。
    pub auth_token: String,
    pub notify: NotifyFn,
    pub presence_dispatch: PresenceDispatchFn,
    /// 人格卡片更新后把名字写回实例清单（写回式回填）。
    pub on_card_name: CardNameFn,
    /// 实例注册表查询（`registry::list`）。
    pub registry_list: RegistryListFn,
    /// 群组文件目录（P2-4，app 层 app_config_dir 注入）。
    pub groups_dir: std::path::PathBuf,
}

#[cfg(test)]
mod tests {
    use super::MemoryPool;

    fn temp_db(tag: &str) -> diver_memory::db::DualDb {
        let dir = std::env::temp_dir().join(format!("diver-pool-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        diver_memory::db::DualDb::open(&dir.join("private.db"), &dir.join("shared.db")).unwrap()
    }

    /// P1-2 记忆隔离验收的自动化守卫：身份路由到各自私有库，无头/未知回退 active。
    #[test]
    fn routes_by_identity_and_falls_back_to_active() {
        let mut pool = MemoryPool::new("alpha");
        pool.insert("alpha", temp_db("alpha"));
        pool.insert("beta", temp_db("beta"));

        let a = pool.resolve(Some("alpha")).unwrap();
        let b = pool.resolve(Some("beta")).unwrap();
        assert!(
            !std::ptr::eq(&*a as *const _, &*b as *const _),
            "alpha/beta 必须路由到不同私有库"
        );
        let unnamed = pool.resolve(None).unwrap();
        assert!(
            std::ptr::eq(&*unnamed as *const _, &*a as *const _),
            "无身份头应回退 active 实例"
        );
        let unknown = pool.resolve(Some("gamma")).unwrap();
        assert!(
            std::ptr::eq(&*unknown as *const _, &*a as *const _),
            "未知身份应回退 active 实例"
        );
    }
}
