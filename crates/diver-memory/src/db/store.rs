//! MemoryDb 句柄：打开库、聚合 stats / snapshot 门面。

use std::path::Path;

use rusqlite::Connection;

use super::schema::SCHEMA;
use super::types::{Snapshot, Stats, TopStat};
use super::util::SNAPSHOT_DEFAULT_LIMIT;

pub struct MemoryDb {
    /// 同 crate 子模块（topics/entities/…）的 impl 块需要读写连接。
    pub(super) conn: Connection,
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
