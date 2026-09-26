//! 私有 + 共享双库门面（0.2.0 多实例互联）。
//!
//! 双库布局：每个实例一个私有库（diver-memory-<id>.sqlite3），多实例之间再共享一个 shared 库。
//! 共享层第一版只放 events：`append_event` 按 `shared` 标志路由写入；
//! topics / relation_card / promises / self_history / entities 等其余写入一律只进私有库，
//! relation_card 人格卡片永远不出私有库。
//! 读取侧只有 events 做「私有 ∪ 共享」合并，card / topics / promises 恒私有。

use std::path::Path;

use super::store::MemoryDb;
use super::types::{MemoryEvent, Snapshot, Stats};
use super::util::SNAPSHOT_DEFAULT_LIMIT;

pub struct DualDb {
    private: MemoryDb,
    shared: MemoryDb,
}

impl DualDb {
    /// 打开私有库与共享库。两库都建完整 schema（共享库第一版只用到 events 表）。
    pub fn open(private_path: &Path, shared_path: &Path) -> rusqlite::Result<Self> {
        Ok(Self {
            private: MemoryDb::open(private_path)?,
            shared: MemoryDb::open(shared_path)?,
        })
    }

    /// 私有库句柄（合并视图之外的能力可显式取用）。
    pub fn private(&self) -> &MemoryDb {
        &self.private
    }

    /// 共享库句柄。正常路径只应读写 events；直接写其它表属于越权脏数据，
    /// 保留此句柄仅供测试验证隔离性。
    pub fn shared(&self) -> &MemoryDb {
        &self.shared
    }

    /// 事件写入按 `shared` 路由：true 进共享库、false 进私有库。
    /// 复用 `MemoryDb::append_event`（含 events 表按 seq 裁剪）。
    pub fn append_event(
        &self,
        topic_id: &str,
        statement: &str,
        ts: Option<i64>,
        episode_id: Option<String>,
        shared: bool,
    ) -> rusqlite::Result<()> {
        let target = if shared { &self.shared } else { &self.private };
        target.append_event(topic_id, statement, ts, episode_id)
    }

    /// 两库「今天」（近 24 小时）事件合并：按 ts 升序，同 ts 私有在前，再按 seq 升序。
    pub fn today_events(&self) -> rusqlite::Result<Vec<MemoryEvent>> {
        Ok(merge_ascending(
            self.private.today_events()?,
            self.shared.today_events()?,
        ))
    }

    /// 两库各取 `limit` 条合并后取「最新 `limit` 条」，再整体转为升序返回（与单库语义一致）。
    /// 「最新」按 ts 降序衡量，等价于升序序的末尾 `limit` 条；并列 ts 被截断时保留升序序
    /// 靠后的条目（降序取法即升序比较器的严格逆序），保证结果确定。
    pub fn recent_events(&self, limit: usize) -> rusqlite::Result<Vec<MemoryEvent>> {
        let mut merged = merge_ascending(
            self.private.recent_events(limit)?,
            self.shared.recent_events(limit)?,
        );
        let start = merged.len().saturating_sub(limit);
        Ok(merged.split_off(start))
    }

    /// 私有库 stats；`events` 计数再加上共享库 events 行数。
    /// 共享库直接 COUNT 而不是复用 `stats()`，避免其内部 decay_all 对共享库产生写副作用。
    pub fn stats(&self) -> rusqlite::Result<Stats> {
        let mut stats = self.private.stats()?;
        let shared_events: i64 = self
            .shared
            .conn
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))?;
        stats.events += shared_events as usize;
        Ok(stats)
    }

    /// 快照：events 用合并后的 recent_events；card / topics / promises 恒私有。
    pub fn snapshot(&self, limit: Option<usize>) -> rusqlite::Result<Snapshot> {
        self.private.decay_all()?;
        let limit = limit.unwrap_or(SNAPSHOT_DEFAULT_LIMIT).max(1);
        Ok(Snapshot {
            card: self.private.get_card()?,
            topics: self.private.recent_topics(limit)?,
            promises: self.private.list_promises(None)?,
            events: self.recent_events(limit)?,
        })
    }
}

/// 其余能力（remember / update_card / upsert_promise / entities 系列…）经 Deref 直达私有库。
/// DualDb 自身的 inherent method 优先于 deref，天然覆盖 append_event / today_events /
/// recent_events / stats / snapshot。
impl std::ops::Deref for DualDb {
    type Target = MemoryDb;

    fn deref(&self) -> &MemoryDb {
        &self.private
    }
}

/// 两库事件合并排序（纯逻辑）：ts 升序 → 私有在前 → seq 升序，保证确定性。
/// seq 是各库自增主键、跨库会重叠，所以来源优先级必须排在 seq 之前。
fn merge_ascending(private: Vec<MemoryEvent>, shared: Vec<MemoryEvent>) -> Vec<MemoryEvent> {
    let mut merged: Vec<(u8, MemoryEvent)> = Vec::with_capacity(private.len() + shared.len());
    merged.extend(private.into_iter().map(|e| (0, e)));
    merged.extend(shared.into_iter().map(|e| (1, e)));
    merged.sort_by(|a, b| {
        a.1.ts.cmp(&b.1.ts)
            .then_with(|| a.0.cmp(&b.0))
            .then_with(|| a.1.seq.cmp(&b.1.seq))
    });
    merged.into_iter().map(|(_, e)| e).collect()
}

#[cfg(test)]
mod tests;
