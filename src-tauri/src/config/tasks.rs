//! 任务委派持久化（0.2.0 codingagent 任务委派）：`<cos_home>/tasks.json`。
//! 模型与状态机在 `types`/`ops`；此处只做 Path 注入的读写（`config::load_at` 惯例）。

pub mod ops;
pub mod types;

pub use ops::*;
pub use types::*;

use std::path::Path;

/// 读任务注册表（缺文件 = 空表）。
pub fn load_at(base: &Path) -> TasksFile {
    crate::config::load_at(base, FILE_NAME)
}

/// 写任务注册表。
pub fn save_at(base: &Path, file: &TasksFile) -> bool {
    crate::config::save_at(base, FILE_NAME, file)
}
