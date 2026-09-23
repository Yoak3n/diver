//! 事件追加 / 裁剪 / 查询，以及 remember 入口。

use rusqlite::params;

use super::mappers::{event_from_row, topic_from_row};
use super::types::{MemoryEvent, TopicRow};
use super::util::{now_ms, DAY_MS, MAX_EVENTS};
use super::MemoryDb;

impl MemoryDb {
    pub fn remember(
        &self,
        content: &str,
        topic: Option<&str>,
    ) -> rusqlite::Result<String> {
        let content = content.trim();
        let name = topic
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| content.chars().take(20).collect());
        let candidates = self.blocking_candidates(&name, Some(3))?;
        if let Some(hit) = candidates.first() {
            let id = hit.topic.id.clone();
            self.activate(&id, None)?;
            self.merge_topic(&id, Some(content), None, None)?;
            Ok(id)
        } else {
            self.create_topic(&name, content, Some("episodic"), Some(false))
        }
    }

    pub fn append_event(
        &self,
        topic_id: &str,
        statement: &str,
        ts: Option<i64>,
        episode_id: Option<String>,
    ) -> rusqlite::Result<()> {
        let ts = ts.unwrap_or_else(now_ms);
        self.conn.execute(
            "INSERT INTO events (topic_id, statement, ts, episode_id) VALUES (?1, ?2, ?3, ?4)",
            params![topic_id, statement, ts, episode_id],
        )?;
        self.prune_events(MAX_EVENTS)?;
        Ok(())
    }

    /// 只保留最近 `keep` 条事件，避免长跑后 events 表无限增长。
    fn prune_events(&self, keep: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ?1)",
            params![keep],
        )?;
        Ok(())
    }

    pub fn today_events(&self) -> rusqlite::Result<Vec<MemoryEvent>> {
        let start = now_ms() - DAY_MS; // "今天"近似取最近 24 小时
        let mut stmt = self
            .conn
            .prepare("SELECT seq, topic_id, statement, ts, episode_id FROM events WHERE ts >= ?1 ORDER BY ts ASC")?;
        let rows = stmt.query_map(params![start], event_from_row)?;
        rows.collect()
    }

    pub fn recent_episodes(
        &self,
        days: Option<i64>,
        limit: Option<usize>,
    ) -> rusqlite::Result<Vec<TopicRow>> {
        let days = days.unwrap_or(14);
        let limit = limit.unwrap_or(4);
        self.decay_all()?;
        let cutoff = now_ms() - days * DAY_MS;
        let mut stmt = self.conn.prepare(
            "SELECT * FROM topics WHERE tier = 'episodic' AND last_discussed_at >= ?1 ORDER BY last_discussed_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![cutoff, limit as i64], topic_from_row)?;
        rows.collect()
    }

    pub(super) fn recent_events(&self, limit: usize) -> rusqlite::Result<Vec<MemoryEvent>> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, topic_id, statement, ts, episode_id FROM events ORDER BY seq DESC LIMIT ?1")?;
        let mut rows: Vec<MemoryEvent> = stmt.query_map(params![limit as i64], event_from_row)?.collect::<rusqlite::Result<_>>()?;
        rows.reverse();
        Ok(rows)
    }
}
