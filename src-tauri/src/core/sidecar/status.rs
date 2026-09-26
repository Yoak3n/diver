//! sidecar 状态枚举与状态快照（含日志环形缓冲）。

use serde::Serialize;

/// 日志环形缓冲上限。
pub(super) const LOG_CAPACITY: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SidecarState {
    Stopped,
    Starting,
    Running,
    Crashed,
}

#[derive(Debug, Clone, Serialize)]
pub struct SidecarStatus {
    /// 实例 id（P2-3 多实例 UI：事件全实例广播，前端按 id 过滤）。
    /// 由 `SidecarManager::status()` 从注册表定位盖章，构造时留空。
    pub id: String,
    pub state: SidecarState,
    pub port: u16,
    /// 最近日志（新→旧）。
    pub logs: Vec<String>,
}
