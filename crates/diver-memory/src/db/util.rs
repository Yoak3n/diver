//! 时间戳 / id / 衰减等纯工具。

use std::sync::atomic::{AtomicU64, Ordering};

use super::types::TopicRow;

pub(super) const DAY_MS: i64 = 24 * 60 * 60 * 1000;

pub(super) const DECAY_RULES: [(&str, f64, f64); 2] = [
    ("episodic", 0.05, 0.02),
    ("trivia", 0.15, 0.1),
];

/// snapshot 视图缓存的最近条数上限（topics 与 events 各一份；card/promises 保持全量）。
pub const SNAPSHOT_DEFAULT_LIMIT: usize = 200;
/// events 表最多保留的最近事件数（超出后按 seq 裁剪最旧记录）。
pub(super) const MAX_EVENTS: i64 = 2000;

/// 全局 id 计数器（进程内唯一已足够，id 仅是数据库主键）。
pub(super) static ID_SEQ: AtomicU64 = AtomicU64::new(0);

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) fn new_id(prefix: &str) -> String {
    let ts = now_ms();
    let seq = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{ts:x}-{seq:x}")
}

pub(super) fn decay(row: &mut TopicRow, now: i64) -> bool {
    let rule = DECAY_RULES
        .iter()
        .find(|(t, _, _)| *t == row.tier.as_str())
        .copied()
        .unwrap_or(("trivia", 0.15, 0.1));
    let days = ((now - row.last_discussed_at) as f64 / DAY_MS as f64).max(0.0);
    row.weight = (row.weight - rule.1 * days).max(0.0);
    row.weight < rule.2
}
