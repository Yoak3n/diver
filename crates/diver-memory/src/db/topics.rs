//! 主题 CRUD、衰减、激活、候选与降级。

use rusqlite::{params, OptionalExtension};

use super::mappers::topic_from_row;
use super::types::{CandidateRow, TopicRow};
use super::util::{decay, new_id, now_ms};
use super::MemoryDb;

impl MemoryDb {
    pub fn list_topics(&self) -> rusqlite::Result<Vec<TopicRow>> {
        self.decay_all()?;
        self.raw_topics()
    }

    fn raw_topics(&self) -> rusqlite::Result<Vec<TopicRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM topics ORDER BY last_discussed_at DESC")?;
        let rows = stmt.query_map([], topic_from_row)?;
        rows.collect()
    }

    pub fn get_topic(&self, id: &str) -> rusqlite::Result<Option<TopicRow>> {
        self.conn
            .query_row(
                "SELECT * FROM topics WHERE id = ?1",
                params![id],
                topic_from_row,
            )
            .optional()
    }

    pub fn create_topic(
        &self,
        canonical_name: &str,
        state_summary: &str,
        tier: Option<&str>,
        uncertain: Option<bool>,
    ) -> rusqlite::Result<String> {
        let id = new_id("t");
        let now = now_ms();
        let tier = tier.unwrap_or("trivia").to_string();
        let uncertain = uncertain.unwrap_or(true);
        let aliases = serde_json::to_string(&[canonical_name]).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "INSERT INTO topics (id, canonical_name, aliases, state_summary, weight, tier, activation_count, created_at, last_discussed_at, n_times, uncertain) \
             VALUES (?1, ?2, ?3, ?4, 1.0, ?5, 0, ?6, ?6, 1, ?7)",
            params![id, canonical_name, aliases, state_summary, tier, now, uncertain],
        )?;
        Ok(id)
    }

    pub fn merge_topic(
        &self,
        id: &str,
        state_summary: Option<&str>,
        alias: Option<&str>,
        action: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let Some(mut row) = self.get_topic(id)? else {
            return Ok(false);
        };
        if let Some(state) = state_summary {
            row.state_summary = state.to_string();
        }
        if let Some(alias) = alias {
            if !alias.is_empty() && alias != row.canonical_name && !row.aliases.iter().any(|a| a == alias) {
                row.aliases.push(alias.to_string());
            }
        }
        row.last_discussed_at = now_ms();
        row.n_times += 1;
        if action != Some("correct") {
            row.uncertain = false;
        }
        let aliases = serde_json::to_string(&row.aliases).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "UPDATE topics SET state_summary = ?1, aliases = ?2, last_discussed_at = ?3, n_times = ?4, uncertain = ?5 WHERE id = ?6",
            params![row.state_summary, aliases, row.last_discussed_at, row.n_times, row.uncertain, id],
        )?;
        Ok(true)
    }

    pub fn delete_topic(&self, id: &str) -> rusqlite::Result<()> {
        // 遗忘/主动删除主题时，连带清理该主题的 events，避免孤儿事件无限增长。
        self.conn
            .execute("DELETE FROM events WHERE topic_id = ?1", params![id])?;
        self.conn
            .execute("DELETE FROM topics WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn decay_all(&self) -> rusqlite::Result<()> {
        let now = now_ms();
        let topics = self.raw_topics()?;
        for mut row in topics {
            if decay(&mut row, now) {
                self.delete_topic(&row.id)?;
            } else {
                self.conn.execute(
                    "UPDATE topics SET weight = ?1, last_discussed_at = ?2 WHERE id = ?3",
                    params![row.weight, row.last_discussed_at, row.id],
                )?;
            }
        }
        Ok(())
    }

    pub fn activate(&self, id: &str, now: Option<i64>) -> rusqlite::Result<bool> {
        let now = now.unwrap_or_else(now_ms);
        let Some(mut row) = self.get_topic(id)? else {
            return Ok(false);
        };
        row.activation_count += 1;
        row.weight = row.weight.max(0.6);
        row.last_discussed_at = now;
        self.conn.execute(
            "UPDATE topics SET activation_count = ?1, weight = ?2, last_discussed_at = ?3 WHERE id = ?4",
            params![row.activation_count, row.weight, row.last_discussed_at, id],
        )?;
        Ok(true)
    }

    pub fn activate_by_text(&self, text: &str) -> rusqlite::Result<()> {
        if text.is_empty() {
            return Ok(());
        }
        for row in self.list_topics()? {
            for name in std::iter::once(row.canonical_name.clone()).chain(row.aliases.clone()) {
                if name.chars().count() >= 2 && text.contains(&name) {
                    self.activate(&row.id, None)?;
                    break;
                }
            }
        }
        Ok(())
    }

    pub fn blocking_candidates(
        &self,
        text: &str,
        limit: Option<usize>,
    ) -> rusqlite::Result<Vec<CandidateRow>> {
        let limit = limit.unwrap_or(5);
        if text.is_empty() {
            return Ok(vec![]);
        }
        let mut hits = vec![];
        for row in self.list_topics()? {
            let mut matched: Option<String> = None;
            for name in std::iter::once(row.canonical_name.clone()).chain(row.aliases.clone()) {
                if name.chars().count() >= 2 && text.contains(&name) {
                    if matched.as_ref().map(|m| name.chars().count() > m.chars().count()).unwrap_or(true) {
                        matched = Some(name);
                    }
                }
            }
            if let Some(matched) = matched {
                hits.push(CandidateRow { topic: row, matched });
            }
        }
        hits.sort_by(|a, b| b.matched.chars().count().cmp(&a.matched.chars().count()));
        hits.truncate(limit);
        Ok(hits)
    }

    pub fn demote(&self, id: &str, reason: Option<String>) -> rusqlite::Result<bool> {
        let Some(mut row) = self.get_topic(id)? else {
            return Ok(false);
        };
        row.weight = row.weight.min(0.3);
        row.demoted_at = Some(now_ms());
        row.demoted_reason = reason.filter(|s| !s.is_empty());
        self.conn.execute(
            "UPDATE topics SET weight = ?1, demoted_at = ?2, demoted_reason = ?3 WHERE id = ?4",
            params![row.weight, row.demoted_at, row.demoted_reason, id],
        )?;
        Ok(true)
    }

    pub(super) fn recent_topics(&self, limit: usize) -> rusqlite::Result<Vec<TopicRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM topics ORDER BY last_discussed_at DESC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit as i64], topic_from_row)?;
        rows.collect()
    }
}
