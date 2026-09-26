//! 实例清单单测：纯逻辑（id 生成 / CRUD 保护）+ 纯路径读写（roundtrip / missing-default）。

use super::*;

fn tmp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("diver-inst-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn load_save_at_roundtrip() {
    let dir = tmp_dir("roundtrip");
    let mut reg = InstancesFile::default();
    reg.create("Echo", 100).unwrap();
    assert!(save_config_at(&dir, &reg));
    let loaded = load_config_at(&dir);
    assert_eq!(loaded, reg);
    assert_eq!(loaded.schema_version, 1);
    assert_eq!(loaded.instances[0].id, "echo");
    assert_eq!(loaded.instances[0].created_at, 100);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_file_seeds_default() {
    let dir = tmp_dir("seed");
    let reg = load_or_seed_at(&dir, 42);
    assert_eq!(reg.instances.len(), 1);
    assert_eq!(reg.instances[0].id, DEFAULT_ID);
    assert_eq!(reg.instances[0].name, DEFAULT_NAME);
    assert!(reg.instances[0].enabled);
    // 自动补登记应落盘，重启后不再重复
    let again = load_or_seed_at(&dir, 43);
    assert_eq!(again.instances.len(), 1);
    assert_eq!(again.instances[0].created_at, 42);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_default_entry_is_re_registered() {
    let dir = tmp_dir("missing-default");
    let mut reg = InstancesFile::default();
    reg.create("Echo", 100).unwrap();
    assert!(save_config_at(&dir, &reg));
    let seeded = load_or_seed_at(&dir, 200);
    assert_eq!(seeded.instances.len(), 2);
    assert_eq!(seeded.instances[0].id, DEFAULT_ID);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn create_generates_path_safe_unique_ids() {
    let mut reg = InstancesFile::default();
    reg.ensure_default(1);
    // 中文名无 ASCII 可用 → 兜底 inst 骨架
    assert_eq!(reg.create("小潜二号", 2).unwrap().id, "inst");
    // 同骨架冲突追加序号
    assert_eq!(reg.create("小潜三号", 3).unwrap().id, "inst-2");
    // ASCII 名 slug 化；default 骨架被占 → default-2
    assert_eq!(reg.create("Echo Bot", 4).unwrap().id, "echo-bot");
    assert_eq!(reg.create("Default", 5).unwrap().id, "default-2");
    for i in &reg.instances {
        assert!(is_valid_id(&i.id), "id 非路径安全：{}", i.id);
    }
}

#[test]
fn default_is_protected_and_others_removable() {
    let mut reg = InstancesFile::default();
    reg.ensure_default(1);
    let echo = reg.create("Echo", 2).unwrap();
    assert_eq!(
        reg.remove(DEFAULT_ID),
        Err(InstanceError::ProtectedDefault)
    );
    assert!(reg.remove("nope").is_err());
    assert_eq!(reg.remove(&echo.id), Ok(()));
    assert!(reg.instances.iter().all(|i| i.id != echo.id));
}

#[test]
fn update_renames_and_toggles() {
    let mut reg = InstancesFile::default();
    let echo = reg.create("Echo", 1).unwrap();
    let updated = reg.update(&echo.id, Some("回声"), Some(false)).unwrap();
    assert_eq!(updated.name, "回声");
    assert!(!updated.enabled);
    assert_eq!(updated.id, echo.id);
    assert_eq!(updated.created_at, echo.created_at);
    assert_eq!(
        reg.update("nope", Some("x"), None),
        Err(InstanceError::NotFound)
    );
    assert_eq!(
        reg.update(&echo.id, Some("  "), None),
        Err(InstanceError::InvalidName)
    );
}

#[test]
fn legacy_json_without_new_fields_parses() {
    // 旧/最小形态：只有 id + name，其余字段走 serde 默认
    let json = r#"{"schemaVersion":1,"instances":[{"id":"default","name":"小潜"}]}"#;
    let reg: InstancesFile = serde_json::from_str(json).unwrap();
    assert!(reg.instances[0].enabled);
    assert_eq!(reg.instances[0].avatar, None);
    assert_eq!(reg.instances[0].created_at, 0);
}
