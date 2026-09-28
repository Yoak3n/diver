//! 实例清单单测：纯逻辑（id 生成 / CRUD 保护 / 可选命名）+ 纯路径读写（roundtrip / missing-default）。

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
    reg.create(Some("Echo"), 100).unwrap();
    assert!(save_config_at(&dir, &reg));
    let loaded = load_config_at(&dir);
    assert_eq!(loaded, reg);
    assert_eq!(loaded.schema_version, 1);
    assert_eq!(loaded.instances[0].id, "echo");
    assert_eq!(loaded.instances[0].name.as_deref(), Some("Echo"));
    assert_eq!(loaded.instances[0].created_at, 100);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_file_seeds_default_unnamed() {
    let dir = tmp_dir("seed");
    let reg = load_or_seed_at(&dir, 42);
    assert_eq!(reg.instances.len(), 1);
    assert_eq!(reg.instances[0].id, DEFAULT_ID);
    // 不预命名：名字由人格卡片回填
    assert_eq!(reg.instances[0].name, None);
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
    reg.create(Some("Echo"), 100).unwrap();
    assert!(save_config_at(&dir, &reg));
    let seeded = load_or_seed_at(&dir, 200);
    assert_eq!(seeded.instances.len(), 2);
    assert_eq!(seeded.instances[0].id, DEFAULT_ID);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn create_without_name_is_allowed() {
    let mut reg = InstancesFile::default();
    reg.ensure_default(1);
    // 不命名：name 为 None，id 走兜底骨架
    let a = reg.create(None, 2).unwrap();
    assert_eq!(a.name, None);
    assert_eq!(a.id, "inst");
    let b = reg.create(Some("   "), 3).unwrap();
    assert_eq!(b.name, None);
    assert_eq!(b.id, "inst-2");
}

#[test]
fn create_generates_path_safe_unique_ids() {
    let mut reg = InstancesFile::default();
    reg.ensure_default(1);
    // 中文名无 ASCII 可用 → 兜底 inst 骨架
    assert_eq!(reg.create(Some("小潜二号"), 2).unwrap().id, "inst");
    // 同骨架冲突追加序号
    assert_eq!(reg.create(Some("小潜三号"), 3).unwrap().id, "inst-2");
    // ASCII 名 slug 化；default 骨架被占 → default-2
    assert_eq!(reg.create(Some("Echo Bot"), 4).unwrap().id, "echo-bot");
    assert_eq!(reg.create(Some("Default"), 5).unwrap().id, "default-2");
    for i in &reg.instances {
        assert!(is_valid_id(&i.id), "id 非路径安全：{}", i.id);
    }
}

#[test]
fn default_is_protected_and_others_removable() {
    let mut reg = InstancesFile::default();
    reg.ensure_default(1);
    let echo = reg.create(Some("Echo"), 2).unwrap();
    assert_eq!(
        reg.remove(DEFAULT_ID),
        Err(InstanceError::ProtectedDefault)
    );
    assert!(reg.remove("nope").is_err());
    assert_eq!(reg.remove(&echo.id), Ok(()));
    assert!(reg.instances.iter().all(|i| i.id != echo.id));
}

#[test]
fn update_renames_toggles_and_clears_name() {
    let mut reg = InstancesFile::default();
    let echo = reg.create(Some("Echo"), 1).unwrap();
    let updated = reg.update(&echo.id, Some("回声"), Some(false)).unwrap();
    assert_eq!(updated.name.as_deref(), Some("回声"));
    assert!(!updated.enabled);
    assert_eq!(updated.id, echo.id);
    assert_eq!(updated.created_at, echo.created_at);
    // 空名 = 清空回未命名
    let cleared = reg.update(&echo.id, Some("  "), None).unwrap();
    assert_eq!(cleared.name, None);
    assert_eq!(
        reg.update("nope", Some("x"), None),
        Err(InstanceError::NotFound)
    );
    // 超长名称仍拒绝
    let too_long = "x".repeat(33);
    assert_eq!(
        reg.update(&echo.id, Some(&too_long), None),
        Err(InstanceError::InvalidName)
    );
}

#[test]
fn set_auto_read_toggles_per_instance() {
    let mut reg = InstancesFile::default();
    let echo = reg.create(Some("Echo"), 1).unwrap();
    assert!(echo.auto_read);
    let off = reg.set_auto_read(&echo.id, false).unwrap();
    assert!(!off.auto_read);
    assert_eq!(reg.set_auto_read("nope", true), Err(InstanceError::NotFound));
}

#[test]
fn legacy_json_without_new_fields_parses() {
    // 旧/最小形态：只有 id，其余字段走 serde 默认（name 缺省 = 未命名）
    let json = r#"{"schemaVersion":1,"instances":[{"id":"default"}]}"#;
    let reg: InstancesFile = serde_json::from_str(json).unwrap();
    assert!(reg.instances[0].enabled);
    assert!(reg.instances[0].auto_read);
    assert_eq!(reg.instances[0].name, None);
    assert_eq!(reg.instances[0].avatar, None);
    assert_eq!(reg.instances[0].created_at, 0);
}

// ---------- P1-1 路径派生 ----------

#[test]
fn instance_paths_follow_new_naming() {
    let base = std::path::Path::new("data");
    assert_eq!(cos_home_for(base, "default"), base.join("cos-default"));
    assert_eq!(cos_home_for(base, "a-1"), base.join("cos-a-1"));
    let harness = std::path::Path::new("harness");
    assert_eq!(
        dev_cos_home_for(harness, "default"),
        harness.join(".cos-home-default")
    );
    let m = memory_paths_for(base, "default");
    assert_eq!(m.private, base.join("diver-memory-default.sqlite3"));
    assert_eq!(m.shared, base.join("diver-memory-shared.sqlite3"));
}

#[test]
fn active_instance_is_first_enabled() {
    let mut reg = InstancesFile::default();
    reg.ensure_default(1);
    assert_eq!(active_instance_id_at(&reg), DEFAULT_ID);
    // 第一个 enabled 胜出（default 停用后）
    reg.update(DEFAULT_ID, None, Some(false)).unwrap();
    let echo = reg.create(Some("Echo"), 2).unwrap();
    assert_eq!(active_instance_id_at(&reg), echo.id);
    // 全部停用 → 兜底 default，保证始终有实例可跑
    reg.update(&echo.id, None, Some(false)).unwrap();
    assert_eq!(active_instance_id_at(&reg), DEFAULT_ID);
}
