//! 实例运行时注册项（P1-2 实例注册表）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 一条运行时注册：一个正在运行的 sidecar 实例。
///
/// 落盘位置 `<app_data_dir>/instances/<id>.json`（壳层运行时簿记，区别于
/// `app_config_dir/instances.json` 实例清单）。就绪时写、退出时删；
/// 崩溃残留由 [`crate::core::instance_registry::sweep_stale_at`] 按 pid 清扫。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRecord {
    /// 实例 id（不可变，`[a-z0-9-]`）。
    pub id: String,
    /// 实例名（人格卡片回填后可有，`None` = 未命名）。
    pub name: Option<String>,
    /// sidecar 进程 pid。
    pub pid: u32,
    /// sidecar HTTP 端口（P1-2 随机预选）。
    pub port: u16,
    /// 启动时间（Unix 秒）。
    pub started_at: u64,
}

/// 注册表定位：目录 + 实例身份（启动时注入 manager，就绪/退出时消费）。
#[derive(Debug, Clone)]
pub struct RegistryTarget {
    /// 注册表目录（`<app_data_dir>/instances`）。
    pub dir: PathBuf,
    /// 实例 id。
    pub id: String,
    /// 实例名。
    pub name: Option<String>,
}
