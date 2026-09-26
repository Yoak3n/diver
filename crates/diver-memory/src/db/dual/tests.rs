//! DualDb 关键路径单测：写入隔离、读取合并、stats / snapshot 合并与私有隔离。
//! IO 用临时目录注入（进程 id + 计数器命名，Drop 清理），不引第三方依赖。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;

use super::DualDb;
use crate::db::types::MemoryEvent;
use crate::db::util::now_ms;

/// 极简临时目录句柄。
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("diver-dual-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn db_path(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn open_dual(dir: &TempDir) -> DualDb {
    DualDb::open(&dir.db_path("private.sqlite3"), &dir.db_path("shared.sqlite3")).unwrap()
}

fn statements(events: Vec<MemoryEvent>) -> Vec<String> {
    events.into_iter().map(|e| e.statement).collect()
}

#[test]
fn append_event_routes_by_shared_flag() {
    let dir = TempDir::new();
    let dual = open_dual(&dir);

    // 两条路由 + 各库直写，验证双库 open 后各自可写
    dual.append_event("t1", "私有事件", None, None, false).unwrap();
    dual.append_event("t1", "共享事件", None, None, true).unwrap();
    dual.private().append_event("t1", "私有直写", None, None).unwrap();
    dual.shared().append_event("t1", "共享直写", None, None).unwrap();

    // 互不泄漏：私有库只看得到私有写入，共享库只看得到共享写入
    assert_eq!(
        statements(dual.private().recent_events(10).unwrap()),
        ["私有事件", "私有直写"]
    );
    assert_eq!(
        statements(dual.shared().recent_events(10).unwrap()),
        ["共享事件", "共享直写"]
    );
}

#[test]
fn merged_events_follow_ts_then_source_then_seq() {
    let dir = TempDir::new();
    let dual = open_dual(&dir);
    let base = now_ms();

    // 私有：同 ts 两条（验证 seq 升序）+ 一条更近
    dual.append_event("t", "p1", Some(base - 1000), None, false).unwrap();
    dual.append_event("t", "p2", Some(base - 1000), None, false).unwrap();
    dual.append_event("t", "p3", Some(base - 500), None, false).unwrap();
    // 共享：更早一条、与私有同 ts 一条（应排在私有之后）、更近一条
    dual.append_event("t", "s1", Some(base - 2000), None, true).unwrap();
    dual.append_event("t", "s1b", Some(base - 1000), None, true).unwrap();
    dual.append_event("t", "s2", Some(base - 400), None, true).unwrap();

    // today_events：ts 升序 → 同 ts 私有在前 → seq 升序
    assert_eq!(
        statements(dual.today_events().unwrap()),
        ["s1", "p1", "p2", "s1b", "p3", "s2"]
    );
    // recent_events 全量：同样升序返回，包含两库事件
    assert_eq!(
        statements(dual.recent_events(10).unwrap()),
        ["s1", "p1", "p2", "s1b", "p3", "s2"]
    );
    // recent_events 截断：取最新 3 条（升序序末尾），并列 ts 被截断时保留靠后条目
    assert_eq!(statements(dual.recent_events(3).unwrap()), ["s1b", "p3", "s2"]);
}

#[test]
fn stats_sums_events_and_snapshot_keeps_card_private() {
    let dir = TempDir::new();
    let dual = open_dual(&dir);
    let base = now_ms();

    dual.append_event("t", "p1", Some(base - 100), None, false).unwrap();
    dual.append_event("t", "s1", Some(base - 200), None, true).unwrap();
    dual.append_event("t", "s2", Some(base - 50), None, true).unwrap();

    // 私有库写主题；共享库被直写主题（脏数据）也不得计入 stats
    dual.remember("私有主题：我在学吉他", None).unwrap();
    dual.shared()
        .create_topic("共享脏主题", "脏数据", Some("episodic"), Some(false))
        .unwrap();

    let stats = dual.stats().unwrap();
    assert_eq!(stats.events, 3); // 私有 1 + 共享 2
    assert_eq!(stats.total, 1); // 主题只数私有库

    // 共享库被直写 card 脏数据，也不得泄漏到 snapshot.card
    dual.shared().update_card(&json!({ "profile": "共享脏画像" })).unwrap();
    dual.update_card(&json!({ "profile": "私有画像" })).unwrap();

    let snap = dual.snapshot(None).unwrap();
    assert!(snap.card.profile.contains("私有画像"));
    assert!(!snap.card.profile.contains("共享脏画像"));
    // events 合并升序；topics 恒私有
    assert_eq!(statements(snap.events), ["s1", "p1", "s2"]);
    assert_eq!(snap.topics.len(), 1);
    assert_eq!(snap.topics[0].canonical_name, "私有主题：我在学吉他");
}

#[test]
fn deref_writes_stay_in_private_db() {
    let dir = TempDir::new();
    let dual = open_dual(&dir);

    // remember / update_card / upsert_promise 都经 Deref 落私有库
    dual.remember("我叫小明，喜欢弹吉他", None).unwrap();
    dual.update_card(&json!({ "relationship": "同事小明" })).unwrap();
    dual.upsert_promise("周五交周报", None, None).unwrap();

    assert_eq!(dual.private().list_topics().unwrap().len(), 1);
    assert_eq!(dual.private().list_promises(None).unwrap().len(), 1);
    assert!(dual.private().get_card().unwrap().relationship.contains("同事小明"));

    // 共享库无感
    assert!(dual.shared().list_topics().unwrap().is_empty());
    assert!(dual.shared().list_promises(None).unwrap().is_empty());
    assert!(dual.shared().get_card().unwrap().relationship.is_empty());
    assert!(dual.shared().recent_events(10).unwrap().is_empty());
}
