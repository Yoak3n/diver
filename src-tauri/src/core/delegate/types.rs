//! 委派领域类型与常量。

use std::time::Duration;

/// 摘要节拍（拍板：相变 + 45s 周期摘要）。
pub const DIGEST_INTERVAL: Duration = Duration::from_secs(45);
/// 任务超时缺省（超时 → stuck，求援不静默）。
pub const DEFAULT_TIMEOUT_SECS: u64 = 1800;

/// 分发所需路径（app/setup 注入；core 不摸 AppHandle）。
#[derive(Debug, Clone)]
pub struct Paths {
    /// `app_data_dir`（`cos_home_for` 基座）。
    pub data_dir: std::path::PathBuf,
    /// 实例注册表目录（回报寻址）。
    pub registry_dir: std::path::PathBuf,
}
