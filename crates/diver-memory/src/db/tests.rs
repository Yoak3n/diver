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
