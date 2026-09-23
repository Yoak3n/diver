//! 自我行动记录（self_history）。

use rusqlite::params;

use super::mappers::action_from_row;
use super::types::SelfAction;
use super::util::{new_id, now_ms};
use super::MemoryDb;

impl MemoryDb {
    pub fn append_self_action(
        &self,
        kind: &str,
        content: &str,
        topic_id: Option<&str>,
        ts: Option<i64>,
    ) -> rusqlite::Result<()> {
        if content.trim().is_empty() {
            return Ok(());
        }
        let ts = ts.unwrap_or_else(now_ms);
        self.conn.execute(
            "INSERT INTO self_history (id, kind, content, topic_id, ts) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![new_id("a"), kind, content, topic_id, ts],
        )?;
        // 最多保留最近 200 条
        self.conn.execute(
            "DELETE FROM self_history WHERE id NOT IN (SELECT id FROM self_history ORDER BY seq DESC LIMIT 200)",
            [],
        )?;
        Ok(())
    }

    pub fn recent_self_actions(
        &self,
        kind: Option<&str>,
        limit: Option<usize>,
    ) -> rusqlite::Result<Vec<SelfAction>> {
        let limit = limit.unwrap_or(5);
        let sql = match kind {
            Some(_) => "SELECT id, kind, content, topic_id, ts FROM self_history WHERE kind = ?1 ORDER BY seq DESC LIMIT ?2",
            None => "SELECT id, kind, content, topic_id, ts FROM self_history ORDER BY seq DESC LIMIT ?2",
        };
        let mut stmt = self.conn.prepare(sql)?;
        let mut rows: Vec<SelfAction> = match kind {
            Some(k) => stmt.query_map(params![k, limit as i64], action_from_row)?.collect::<rusqlite::Result<_>>()?,
            None => stmt.query_map(params![limit as i64], action_from_row)?.collect::<rusqlite::Result<_>>()?,
        };
        rows.reverse();
        Ok(rows)
    }
}
