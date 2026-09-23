//! 承诺（promises）读写。

use rusqlite::params;

use super::mappers::promise_from_row;
use super::types::PromiseRow;
use super::util::{new_id, now_ms};
use super::MemoryDb;

impl MemoryDb {
    pub fn list_promises(&self, status: Option<&str>) -> rusqlite::Result<Vec<PromiseRow>> {
        let sql = match status {
            Some(_) => "SELECT id, content, status, created_at, due_at, updated_at FROM promises WHERE status = ?1 ORDER BY created_at ASC",
            None => "SELECT id, content, status, created_at, due_at, updated_at FROM promises ORDER BY created_at ASC",
        };
        let mut stmt = self.conn.prepare(sql)?;
        let rows = match status {
            Some(s) => stmt.query_map(params![s], promise_from_row)?.collect(),
            None => stmt.query_map([], promise_from_row)?.collect(),
        };
        rows
    }

    pub fn upsert_promise(
        &self,
        content: &str,
        status: Option<&str>,
        due_at: Option<i64>,
    ) -> rusqlite::Result<()> {
        let content = content.trim();
        if content.is_empty() {
            return Ok(());
        }
        let now = now_ms();
        let existing = self.list_promises(None)?;
        let found = existing.iter().find(|p| {
            p.status != "expired"
                && (p.content == content || p.content.contains(content) || content.contains(p.content.as_str()))
        });
        if let Some(p) = found {
            let status = if status == Some("done") { "done".to_string() } else { p.status.clone() };
            self.conn.execute(
                "UPDATE promises SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status, now, p.id],
            )?;
        } else {
            self.conn.execute(
                "INSERT INTO promises (id, content, status, created_at, due_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                params![new_id("p"), content, status.unwrap_or("open"), now, due_at],
            )?;
        }
        // 最多保留最近 100 条
        self.conn.execute(
            "DELETE FROM promises WHERE id NOT IN (SELECT id FROM promises ORDER BY created_at DESC LIMIT 100)",
            [],
        )?;
        Ok(())
    }
}
