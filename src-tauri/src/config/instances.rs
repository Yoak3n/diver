//! 实例清单（壳层元配置 `app_config_dir/instances.json`）。
//!
//! 清单定义「实例是什么」（id / 名字 / 启用开关 / 头像留位 / 登记时间），位于所有
//! 实例之上——它自身不能被隔离进某个 COS_HOME。实例内设置（人格 / 模型 / 插件集）
//! **不进此文件**，仍走各 `$COS_HOME/diver-settings.json`，COS_HOME 分叉后自动 per-instance。
//!
//! `id` 不可变且路径安全（`[a-z0-9-]`）：P1-1 的 `cos-<id>` 目录名、P1-2 的注册表键
//! 都消费它；`default` 保留给零迁移实例，首次访问由 [`InstancesFile::ensure_default`]
//! 自动登记。P0 边界：只登记不启动，不动 `cos_home()` / 端口 / 单例插件。
//!
//! 分层：[types] 领域类型 / [ops] 纯逻辑（无 IO 可单测）/ 本文件 IO 与装配。

mod ops;
mod types;

#[cfg(test)]
mod tests;

pub use ops::*;
pub use types::*;

use std::path::Path;

use tauri::AppHandle;

use super::{config_dir, load_at, save_at};

/// 当前 Unix 秒（给新条目盖时间戳）。
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 纯路径读取实例清单（文件缺失或损坏时返回空清单）。
pub fn load_config_at(base: &Path) -> InstancesFile {
    load_at(base, FILE_NAME)
}

/// 纯路径保存实例清单，返回是否成功。
pub fn save_config_at(base: &Path, reg: &InstancesFile) -> bool {
    save_at(base, FILE_NAME, reg)
}

/// 读取实例清单并确保 `default` 在册；缺失时自动补登记并落盘（零迁移不倒退）。
pub fn load_or_seed_at(base: &Path, now: u64) -> InstancesFile {
    let mut reg = load_config_at(base);
    if reg.ensure_default(now) {
        save_config_at(base, &reg);
    }
    reg
}

/// 读取实例清单并确保 `default` 在册。
pub fn load_or_seed(app: &AppHandle) -> InstancesFile {
    load_or_seed_at(&config_dir(app), now_secs())
}

/// 列出全部实例（首次访问自动登记 `default`）。
pub fn list_instances(app: &AppHandle) -> Vec<InstanceMeta> {
    load_or_seed(app).instances
}

/// 登记新实例并落盘（P0 只登记不启动）；`name` 可选——不命名留 `None`，
/// 名字通常由用户与其聊天后经人格卡片回填。
pub fn create_instance(app: &AppHandle, name: Option<&str>) -> Result<InstanceMeta, InstanceError> {
    let base = config_dir(app);
    let now = now_secs();
    let mut reg = load_or_seed_at(&base, now);
    let meta = reg.create(name, now)?;
    if save_config_at(&base, &reg) {
        Ok(meta)
    } else {
        Err(InstanceError::Io)
    }
}

/// 改名 / 启用开关并落盘。
pub fn update_instance(
    app: &AppHandle,
    id: &str,
    name: Option<&str>,
    enabled: Option<bool>,
) -> Result<InstanceMeta, InstanceError> {
    let base = config_dir(app);
    let mut reg = load_or_seed_at(&base, now_secs());
    let meta = reg.update(id, name, enabled)?;
    if save_config_at(&base, &reg) {
        Ok(meta)
    } else {
        Err(InstanceError::Io)
    }
}

/// 删除实例并落盘（`default` 拒绝）。
pub fn delete_instance(app: &AppHandle, id: &str) -> Result<(), InstanceError> {
    let base = config_dir(app);
    let mut reg = load_or_seed_at(&base, now_secs());
    reg.remove(id)?;
    if save_config_at(&base, &reg) {
        Ok(())
    } else {
        Err(InstanceError::Io)
    }
}
