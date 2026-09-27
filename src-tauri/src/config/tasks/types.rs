//! 任务领域类型（委派一期）：TaskRecord 状态机 + tasks.json 载体。

use serde::{Deserialize, Serialize};

/// 配置文件名（实例 `$COS_HOME` 下，per 实例独立）。
pub const FILE_NAME: &str = "tasks.json";

/// 任务状态（状态机字面量，string 落盘便于增量演进）：
/// `queued → running → done | failed | stuck | cancelled | unknown`。
/// `unknown` = 壳重启后仍标记 running 的任务（明示结果不可知，不自动重发）。
pub const STATUS_QUEUED: &str = "queued";
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_STUCK: &str = "stuck";
pub const STATUS_CANCELLED: &str = "cancelled";
pub const STATUS_UNKNOWN: &str = "unknown";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    /// 发起方实例 id（tasks.json 按实例 COS_HOME 分文件，冗余记录便于诊断）。
    pub instance_id: String,
    /// 适配器名（dsh / codex / …）。
    pub agent: String,
    /// 任务正文（工头派单原文，监督层不改动）。
    pub task_text: String,
    pub status: String,
    /// 拼装后的完整命令行（诊断用，不含任务正文）。
    pub command: String,
    #[serde(default)]
    pub pid: Option<u32>,
    pub created_at: u64,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub ended_at: Option<u64>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    /// 终态摘要（done 的输出尾部 / failed 的诊断尾部）。
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TasksFile {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub tasks: Vec<TaskRecord>,
}

fn default_schema_version() -> u32 {
    1
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
