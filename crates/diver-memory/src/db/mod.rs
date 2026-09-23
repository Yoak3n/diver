//! SQLite 记忆存储：topics / events / relation-card / promises / self-history。
//!
//! 设计对应 Node 侧原 store.ts 的双层模型：
//! - events 为 append-only 真相源（陈述原文永不修改）
//! - topics 每主题一行，recall 只查这一层
//! - 衰减 / 激活 / 遗忘均为确定性逻辑，不调用任何 LLM

mod card;
mod entities;
mod events;
mod mappers;
mod promises;
mod schema;
mod self_history;
mod topics;
mod types;
mod util;

#[cfg(test)]
mod tests;

use std::path::Path;

use rusqlite::Connection;

pub use types::*;
pub use util::SNAPSHOT_DEFAULT_LIMIT;

use schema::SCHEMA;

// ───────────────────────── 存储实现 ─────────────────────────

pub struct MemoryDb {
    conn: Connection,
}

impl MemoryDb {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        conn.execute("PRAGMA foreign_keys = ON", [])?;
        conn.execute(
            "INSERT OR IGNORE INTO relation_card (id) VALUES (1)",
            [],
        )?;
        Ok(Self { conn })
    }

    // ───────────────────────── stats / snapshot ─────────────────────────

    pub fn stats(&self) -> rusqlite::Result<Stats> {
        let topics = self.list_topics()?;
        let mut by_tier = std::collections::BTreeMap::new();
        by_tier.insert("episodic".to_string(), 0);
        by_tier.insert("trivia".to_string(), 0);
        for row in &topics {
            *by_tier.entry(row.tier.clone()).or_insert(0) += 1;
        }
        let mut ranked = topics.clone();
        ranked.sort_by(|a, b| b.n_times.cmp(&a.n_times));
        let top = ranked
            .iter()
            .take(5)
            .map(|r| TopStat { name: r.canonical_name.clone(), n_times: r.n_times })
            .collect();
        let events: i64 = self.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        let open_promises: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM promises WHERE status = 'open'",
            [],
            |r| r.get(0),
        )?;
        let entities: i64 = self.conn.query_row("SELECT COUNT(*) FROM entities", [], |r| r.get(0))?;
        Ok(Stats {
            total: topics.len(),
            by_tier,
            top,
            events: events as usize,
            open_promises: open_promises as usize,
            entities: entities as usize,
        })
    }

    pub fn snapshot(&self, limit: Option<usize>) -> rusqlite::Result<Snapshot> {
        self.decay_all()?;
        let limit = limit.unwrap_or(SNAPSHOT_DEFAULT_LIMIT).max(1);
        Ok(Snapshot {
            card: self.get_card()?,
            topics: self.recent_topics(limit)?,
            promises: self.list_promises(None)?,
            events: self.recent_events(limit)?,
        })
    }
}
