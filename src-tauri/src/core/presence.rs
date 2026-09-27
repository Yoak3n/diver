//! 壳端 Companion Presence 接线：每实例一份 FSM + L3 `POST /api/inject`。
//!
//! 状态机/策略纯逻辑在 `diver-presence` crate；本模块只做：
//! - 实例级句柄注册表（多实例各 sidecar 独立回压 busy/事件，互不踩踏）
//! - `/rpc presence::*` 派发与注入下发见子模块 [`rpc`]（按 `x-diver-instance` 路由）

pub mod parse_event;
mod rpc;

pub use rpc::{dispatch_inject, dispatch_rpc, request_and_inject};

use std::collections::HashMap;
use std::sync::Arc;

use diver_presence::{
    CompanionPresence, Event, InjectRequest, Intent, Phase, PresenceSnapshot, ProactiveConfig,
    RequestResult,
};
use parking_lot::Mutex;
use serde_json::{json, Value};

/// 进程级存在感总控（单实例一份）。
pub struct PresenceHandle {
    inner: Mutex<CompanionPresence>,
}

impl PresenceHandle {
    /// 实例 FSM 注册表（get-or-create；随实例删除遗留的空项无害，量级 = 实例数）。
    fn registry() -> &'static Mutex<HashMap<String, Arc<PresenceHandle>>> {
        static REG: once_cell::sync::OnceCell<Mutex<HashMap<String, Arc<PresenceHandle>>>> =
            once_cell::sync::OnceCell::new();
        REG.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// 实例 FSM 句柄；空 id 归到 default（旧 sidecar 不带头时的兜底）。
    pub fn instance(id: &str) -> Arc<PresenceHandle> {
        let key = if id.trim().is_empty() { "default".to_string() } else { id.trim().to_string() };
        let mut reg = Self::registry().lock();
        reg.entry(key)
            .or_insert_with(|| {
                let now = diver_presence::types::now_ms();
                log::info!("[presence] BOOT instance at {now}");
                Arc::new(PresenceHandle { inner: Mutex::new(CompanionPresence::boot(now)) })
            })
            .clone()
    }

    /// active 实例 FSM：桌宠 / 探索 / 主动开口等壳级行为的归属
    /// （与 `SidecarManager::global()` 同源 = 清单第一个 enabled 实例）。
    pub fn active() -> Arc<PresenceHandle> {
        Self::instance(&active_instance_id())
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut CompanionPresence) -> R) -> R {
        let mut g = self.inner.lock();
        f(&mut g)
    }

    pub fn apply_event(&self, ev: Event) {
        let now = diver_presence::types::now_ms();
        // T13：USER_CHAT 打断 explore —— 先取消 L3 job，再迁相位
        if matches!(ev, Event::UserChat) {
            crate::core::explore_policy::cancel_active_job();
        }
        self.with(|p| p.handle(ev, now));
    }

    pub fn phase(&self) -> Phase {
        let now = diver_presence::types::now_ms();
        self.with(|p| p.phase(now))
    }

    pub fn snapshot(&self) -> PresenceSnapshot {
        let now = diver_presence::types::now_ms();
        self.with(|p| p.snapshot(now))
    }

    pub fn set_proactive_config(&self, cfg: ProactiveConfig) {
        self.with(|p| p.set_proactive_config(cfg));
    }

    /// 同步裁决；通过则返回 L3 注入载荷（由调用方 await 发送）。
    pub fn request_proactive_inject(&self, source: &str, text: &str) -> (RequestResult, Option<InjectRequest>) {
        let now = diver_presence::types::now_ms();
        self.with(|p| {
            p.request(
                Intent::ProactiveInject {
                    source: source.to_string(),
                    text: text.to_string(),
                },
                now,
            )
        })
    }
}

/// active 实例 id（注册表定位由 setup 注入 manager；缺省回退 default）。
fn active_instance_id() -> String {
    crate::core::sidecar::SidecarManager::global()
        .instance_id()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "default".to_string())
}

/// 解析实例 id：显式指定优先；空 / 缺省回退 active 实例。
pub fn resolve_instance_id(explicit: Option<&str>) -> String {
    explicit
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(active_instance_id)
}

/// 实例快照 JSON（带 `instance` 身份字段；Tauri 命令与 `/rpc` 共用，UI 标注展示来源）。
pub fn instance_snapshot_json(explicit: Option<&str>) -> Value {
    let resolved = resolve_instance_id(explicit);
    let mut body = serde_json::to_value(PresenceHandle::instance(&resolved).snapshot())
        .unwrap_or(Value::Null);
    if let Some(obj) = body.as_object_mut() {
        obj.insert("instance".into(), json!(resolved));
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use diver_presence::Event;

    #[test]
    fn instance_handles_are_keyed_and_stable() {
        let a = PresenceHandle::instance("test-a");
        let a2 = PresenceHandle::instance("test-a");
        let b = PresenceHandle::instance("test-b");
        assert!(Arc::ptr_eq(&a, &a2));
        assert!(!Arc::ptr_eq(&a, &b));
        // 空 id 归 default
        assert!(Arc::ptr_eq(&PresenceHandle::instance(""), &PresenceHandle::instance("default")));
    }

    #[test]
    fn busy_events_stay_within_their_instance() {
        // 回归：多实例共用单例时，一实例的 Busy(false) 会把另一实例的
        // Thinking 打回 Listening。现按实例隔离：互不影响。
        let a = PresenceHandle::instance("test-iso-a");
        let b = PresenceHandle::instance("test-iso-b");
        for h in [&a, &b] {
            h.apply_event(Event::UserChat);
        }
        a.apply_event(Event::Busy(true));
        assert_eq!(a.phase(), Phase::Thinking);
        assert_eq!(b.phase(), Phase::Listening);
        // b 先结束：a 仍 Thinking
        b.apply_event(Event::Busy(false));
        assert_eq!(a.phase(), Phase::Thinking);
        assert_eq!(b.phase(), Phase::Listening);
    }
}
