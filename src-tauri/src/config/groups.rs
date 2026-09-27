//! 群组配置（P2-4）：`app_config_dir/groups.json` 持久化 + 稳定 re-export。
//! 模型与纯状态迁移在 `types`/`ops`；此处只做 Path 注入的读写（`config::load_at` 惯例）。

pub mod ops;
pub mod types;

pub use ops::*;
pub use types::*;

use std::path::Path;

/// 读取群组文件（`base` = 壳层 app_config_dir）；缺文件/损坏 → 默认（含系统全员群）。
pub fn load_at(base: &Path) -> GroupsFile {
    let mut file: GroupsFile = crate::config::load_at(base, FILE_NAME);
    ensure_general(&mut file);
    file
}

/// 落盘群组文件。
pub fn save_at(base: &Path, file: &GroupsFile) -> Result<(), String> {
    if crate::config::save_at(base, FILE_NAME, file) {
        Ok(())
    } else {
        Err(format!("群组文件写入失败：{}/{}", base.display(), FILE_NAME))
    }
}
