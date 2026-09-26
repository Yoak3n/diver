//! 实例路径派生（纯函数，无 IO）：实例 id → COS_HOME / 记忆库路径。
//!
//! P1-1 分叉规则（2026-09-26 拍板，**不保留旧命名**）：
//! - release 数据家园 `<app_data_dir>/cos-<id>`（default 也走 `cos-default`，旧 `cos/` 弃用）
//! - debug 数据家园 `<harness>/.cos-home-<id>`
//! - 记忆双库 `<app_data_dir>/diver-memory-<id>.sqlite3`（私有）
//!   + `diver-memory-shared.sqlite3`（全体实例共享的小库，显式 `shared: true` 才写）

use std::path::{Path, PathBuf};

use super::types::{InstancesFile, DEFAULT_ID};

/// 实例数据家园（release 形态）：`<base>/cos-<id>`。
pub fn cos_home_for(base: &Path, instance_id: &str) -> PathBuf {
    base.join(format!("cos-{instance_id}"))
}

/// 实例数据家园（debug 形态）：`<harness>/.cos-home-<id>`，与 release 命名平行。
pub fn dev_cos_home_for(harness: &Path, instance_id: &str) -> PathBuf {
    harness.join(format!(".cos-home-{instance_id}"))
}

/// 实例记忆库路径组（壳层 `app_data_dir` 下）。
pub struct MemoryPaths {
    /// 私有库：默认全部读写，实例间互不可见。
    pub private: PathBuf,
    /// 共享库：全体实例共用一个小库，显式 `shared: true` 才写。
    pub shared: PathBuf,
}

/// 实例记忆双库路径：`diver-memory-<id>.sqlite3` + `diver-memory-shared.sqlite3`。
pub fn memory_paths_for(base: &Path, instance_id: &str) -> MemoryPaths {
    MemoryPaths {
        private: base.join(format!("diver-memory-{instance_id}.sqlite3")),
        shared: base.join("diver-memory-shared.sqlite3"),
    }
}

/// 运行时注册表目录：`<app_data_dir>/instances/`（P1-2，每实例一个 `<id>.json`）。
///
/// 注册表是运行时簿记（pid / port / 名字 / 启动时间），区别于 `app_config_dir`
/// 下的实例清单（配置）；两者不同目录，命名平行不混。
pub fn registry_dir_for(base: &Path) -> PathBuf {
    base.join("instances")
}

/// 运行时实例 id：清单里第一个 `enabled` 实例。
///
/// P1-1 仍是单实例运行（多实例拉起在 P1-2 端口协商之后），先消费 P0 实例清单的
/// enabled 开关；清单为空或全部停用时兜底 [`DEFAULT_ID`]，保证始终有实例可跑。
pub fn active_instance_id_at(reg: &InstancesFile) -> String {
    reg.instances
        .iter()
        .find(|i| i.enabled)
        .map(|i| i.id.clone())
        .unwrap_or_else(|| DEFAULT_ID.to_string())
}
