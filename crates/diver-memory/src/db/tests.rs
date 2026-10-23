use super::*;
use std::path::Path;

fn mem_db() -> MemoryDb {
    MemoryDb::open(Path::new(":memory:")).unwrap()
}

#[test]
fn upsert_entity_graph_writes_attrs_and_relations() {
    let db = mem_db();
    let g = db
        .upsert_entity_graph(
            "用户",
            Some("person"),
            &[("忌口".to_string(), "香菜".to_string())],
            &[RelationSpec {
                to_name: "小明".to_string(),
                relation: "同事".to_string(),
                to_type: Some("person".to_string()),
            }],
            None,
        )
        .unwrap();
    assert_eq!(g.entity.name, "用户");
    assert_eq!(g.attrs.len(), 1);
    assert_eq!(g.attrs[0].attr_value, "香菜");
    assert_eq!(g.neighbors.len(), 1);
    assert_eq!(g.neighbors[0].entity.name, "小明");
    assert_eq!(g.neighbors[0].relation, "同事");
}

#[test]
fn attr_is_versioned_and_relation_idempotent() {
    let db = mem_db();
    let e = db.upsert_entity("吉他", Some("habit")).unwrap();
    assert!(db.set_entity_attr(&e.id, "进度", "入门", None).unwrap());
    assert!(!db.set_entity_attr(&e.id, "进度", "入门", None).unwrap());
    assert!(db.set_entity_attr(&e.id, "进度", "能弹小星星", None).unwrap());
    let attrs = db.current_entity_attrs(&e.id).unwrap();
    assert_eq!(attrs.len(), 1);
    assert_eq!(attrs[0].attr_value, "能弹小星星");

    let u = db.upsert_entity("用户", None).unwrap();
    assert!(db.add_entity_relation(&u.id, &e.id, "在学", None).unwrap());
    assert!(!db.add_entity_relation(&u.id, &e.id, "在学", None).unwrap());
}

#[test]
fn entity_candidates_match_name_in_text() {
    let db = mem_db();
    db.upsert_entity_graph(
        "小明",
        Some("person"),
        &[("职业".to_string(), "设计师".to_string())],
        &[RelationSpec {
            to_name: "李雷".to_string(),
            relation: "同事".to_string(),
            to_type: None,
        }],
        None,
    )
    .unwrap();
    let hits = db.entity_candidates("小明最近换工作了吗", Some(5)).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].entity.name, "小明");
    assert!(hits[0].attrs.iter().any(|a| a.attr_key == "职业"));
    let empty = db.entity_candidates("完全无关的话题", Some(5)).unwrap();
    assert!(empty.is_empty());
}

#[test]
fn scoped_remember_does_not_merge_across_scopes() {
    let db = mem_db();
    let owner = db.remember("主人讨厌香菜", Some("饮食"), None).unwrap();
    let group = db
        .remember("群里有人说讨厌香菜", Some("饮食"), Some("group:1"))
        .unwrap();
    assert_ne!(owner, group);

    let rows = db.list_topics().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().any(|r| r.id == owner && r.scope == "owner"));
    assert!(rows.iter().any(|r| r.id == group && r.scope == "group:1"));
}

#[test]
fn blocking_candidates_filters_scope_and_prefix() {
    let db = mem_db();
    db.remember("主人聊过吉他", Some("吉他"), None).unwrap();
    db.remember("一群聊过吉他", Some("吉他"), Some("group:1")).unwrap();
    db.remember("二群聊过吉他", Some("吉他"), Some("group:2")).unwrap();
    db.remember("私聊聊过吉他", Some("吉他"), Some("private:9")).unwrap();

    let all = db.blocking_candidates("吉他", Some(10), None, None, None).unwrap();
    assert_eq!(all.len(), 4);

    let groups = db
        .blocking_candidates(
            "吉他",
            Some(10),
            None,
            Some(&["owner".to_string()]),
            Some(&["private:".to_string()]),
        )
        .unwrap();
    assert_eq!(groups.len(), 2);
    assert!(groups.iter().all(|h| h.topic.scope.starts_with("group:")));

    let only_owner = db
        .blocking_candidates(
            "吉他",
            Some(10),
            Some(&["owner".to_string()]),
            None,
            None,
        )
        .unwrap();
    assert_eq!(only_owner.len(), 1);
    assert_eq!(only_owner[0].topic.scope, "owner");
}

#[test]
fn legacy_topics_table_migrates_scope_to_owner() {
    let dir = std::env::temp_dir().join(format!(
        "diver-memory-legacy-{}-{}",
        std::process::id(),
        "scope"
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("legacy.sqlite3");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE topics (
                id TEXT PRIMARY KEY,
                canonical_name TEXT NOT NULL,
                aliases TEXT NOT NULL,
                state_summary TEXT NOT NULL,
                weight REAL NOT NULL,
                tier TEXT NOT NULL,
                activation_count INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                last_discussed_at INTEGER NOT NULL,
                n_times INTEGER NOT NULL,
                uncertain INTEGER NOT NULL,
                demoted_at INTEGER,
                demoted_reason TEXT
            );
            "#,
        )
        .unwrap();
        conn.execute(
            "INSERT INTO topics VALUES ('t1', '旧话题', '[]', '旧状态', 1.0, 'episodic', 0, ?1, ?1, 1, 0, NULL, NULL)",
            [now],
        )
        .unwrap();
    }
    let db = MemoryDb::open(&path).unwrap();
    let rows = db.list_topics().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].scope, "owner");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn card_name_is_scalar_and_overwrite() {
    let db = mem_db();
    // 初始未命名
    assert_eq!(db.get_card().unwrap().name, None);
    // 非空 name 覆盖写入（标量语义，区别于 profile 的追加式）
    db.update_card(&serde_json::json!({ "name": "小潜" })).unwrap();
    assert_eq!(db.get_card().unwrap().name.as_deref(), Some("小潜"));
    // 同名不动、空名不修改
    db.update_card(&serde_json::json!({ "name": "小潜" })).unwrap();
    db.update_card(&serde_json::json!({ "name": "  " })).unwrap();
    assert_eq!(db.get_card().unwrap().name.as_deref(), Some("小潜"));
    // 新名字覆盖旧名字（回填实例清单的权威源）
    db.update_card(&serde_json::json!({ "name": "Echo" })).unwrap();
    assert_eq!(db.get_card().unwrap().name.as_deref(), Some("Echo"));
    // 空串/缺省 = 不修改（可选字段语义；update_card 无清空能力）
    db.update_card(&serde_json::json!({ "name": "  " })).unwrap();
    db.update_card(&serde_json::json!({ "profile": "- 忙项目" })).unwrap();
    assert_eq!(db.get_card().unwrap().name.as_deref(), Some("Echo"));
    // clear_card_name = 唯一清空通道（仅壳层手动入口）；重复清空幂等
    db.clear_card_name().unwrap();
    assert_eq!(db.get_card().unwrap().name, None);
    db.clear_card_name().unwrap();
    assert_eq!(db.get_card().unwrap().name, None);
}
