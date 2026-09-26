//! 注册表文件读写（`<app_data_dir>/instances/<id>.json`），Path 注入可单测。

use std::path::Path;

use super::pid::pid_alive;
use super::types::{InstanceRecord, RegistryTarget};

fn record_path(dir: &Path, id: &str) -> std::path::PathBuf {
    dir.join(format!("{id}.json"))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 就绪时登记（幂等：同 id 覆盖写）。
pub fn register(target: &RegistryTarget, pid: u32, port: u16) -> std::io::Result<()> {
    let record = InstanceRecord {
        id: target.id.clone(),
        name: target.name.clone(),
        pid,
        port,
        started_at: now_secs(),
    };
    register_at(&target.dir, &record)
}

/// 退出/崩溃时注销；文件不存在视为成功。
pub fn deregister(target: &RegistryTarget) {
    deregister_at(&target.dir, &target.id)
}

/// 写入注册项。
pub fn register_at(dir: &Path, record: &InstanceRecord) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let body = serde_json::to_vec_pretty(record)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(record_path(dir, &record.id), body)
}

/// 删除注册项；文件不存在视为成功。
pub fn deregister_at(dir: &Path, id: &str) {
    let _ = std::fs::remove_file(record_path(dir, id));
}

/// 列出全部注册项（损坏文件跳过；按 id 排序保证稳定顺序）。
pub fn list_at(dir: &Path) -> Vec<InstanceRecord> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(body) = std::fs::read(&path) else {
            continue;
        };
        if let Ok(record) = serde_json::from_slice::<InstanceRecord>(&body) {
            out.push(record);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// 清扫僵尸注册项（pid 已不存活 → 删文件），返回被清扫的记录。
pub fn sweep_stale_at(dir: &Path) -> Vec<InstanceRecord> {
    let mut swept = Vec::new();
    for record in list_at(dir) {
        if !pid_alive(record.pid) {
            deregister_at(dir, &record.id);
            swept.push(record);
        }
    }
    swept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("diver-ireg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(id: &str, pid: u32) -> InstanceRecord {
        InstanceRecord {
            id: id.into(),
            name: Some("小雪".into()),
            pid,
            port: 53621,
            started_at: 1758000000,
        }
    }

    #[test]
    fn register_list_roundtrip() {
        let dir = temp_dir("roundtrip");
        register_at(&dir, &record("default", std::process::id())).unwrap();
        register_at(&dir, &record("beta", std::process::id())).unwrap();
        let all = list_at(&dir);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "beta");
        assert_eq!(all[1].id, "default");
        assert_eq!(all[1].name.as_deref(), Some("小雪"));
        assert_eq!(all[1].port, 53621);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deregister_removes_only_target() {
        let dir = temp_dir("dereg");
        register_at(&dir, &record("default", 1)).unwrap();
        register_at(&dir, &record("beta", 2)).unwrap();
        deregister_at(&dir, "default");
        deregister_at(&dir, "missing"); // 不存在不报错
        let all = list_at(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "beta");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_removes_dead_keeps_live() {
        let dir = temp_dir("sweep");
        register_at(&dir, &record("alive", std::process::id())).unwrap();
        register_at(&dir, &record("dead", 0x7FFF_FFFF)).unwrap();
        let swept = sweep_stale_at(&dir);
        assert_eq!(swept.len(), 1);
        assert_eq!(swept[0].id, "dead");
        let all = list_at(&dir);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "alive");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_skips_malformed_files() {
        let dir = temp_dir("malformed");
        std::fs::write(dir.join("junk.json"), b"not json").unwrap();
        register_at(&dir, &record("default", 1)).unwrap();
        assert_eq!(list_at(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
