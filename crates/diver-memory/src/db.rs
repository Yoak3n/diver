//! SQLite 记忆存储：topics / events / relation-card / promises / self-history。
//!
//! 设计对应 Node 侧原 store.ts 的双层模型：
//! - events 为 append-only 真相源（陈述原文永不修改）
//! - topics 每主题一行，recall 只查这一层
//! - 衰减 / 激活 / 遗忘均为确定性逻辑，不调用任何 LLM

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

const DECAY_RULES: [(&str, f64, f64); 2] = [
    ("episodic", 0.05, 0.02),
    ("trivia", 0.15, 0.1),
];

/// 全局 id 计数器（进程内唯一已足够，id 仅是数据库主键）。
static ID_SEQ: AtomicU64 = AtomicU64::new(0);

// ───────────────────────── 类型 ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicRow {
    pub id: String,
    pub canonical_name: String,
    pub aliases: Vec<String>,
    pub state_summary: String,
    pub weight: f64,
    pub tier: String,
    pub activation_count: i64,
    pub created_at: i64,
    pub last_discussed_at: i64,
    pub n_times: i64,
    pub uncertain: bool,
    pub demoted_at: Option<i64>,
    pub demoted_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvent {
    pub seq: i64,
    pub topic_id: String,
    pub statement: String,
    pub ts: i64,
    pub episode_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationCard {
    pub profile: String,
    #[serde(rename = "agent_model")]
    pub agent_model: String,
    pub relationship: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromiseRow {
    pub id: String,
    pub content: String,
    pub status: String,
    pub created_at: i64,
    pub due_at: Option<i64>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfAction {
    pub id: String,
    pub kind: String,
    pub content: String,
    pub topic_id: Option<String>,
    pub ts: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateRow {
    #[serde(flatten)]
    pub topic: TopicRow,
    pub matched: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total: usize,
    pub by_tier: std::collections::BTreeMap<String, usize>,
    pub top: Vec<TopStat>,
    pub events: usize,
    pub open_promises: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopStat {
    pub name: String,
    pub n_times: i64,
}

/// Node 端同步视图缓存的全量快照。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub card: RelationCard,
    pub topics: Vec<TopicRow>,
    pub promises: Vec<PromiseRow>,
    pub events: Vec<MemoryEvent>,
}

// ───────────────────────── 存储实现 ─────────────────────────

pub struct MemoryDb {
    conn: Connection,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS topics (
    id TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    aliases TEXT NOT NULL,
    state_summary TEXT NOT NULL,
    weight REAL NOT NULL,
    tier TEXT NOT NULL,
    activation_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_discussed_at INTEGER NOT NULL,
    n_times INTEGER NOT NULL,
    uncertain INTEGER NOT NULL,
    demoted_at INTEGER,
    demoted_reason TEXT
);

CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id TEXT NOT NULL,
    statement TEXT NOT NULL,
    ts INTEGER NOT NULL,
    episode_id TEXT
);

CREATE TABLE IF NOT EXISTS relation_card (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    profile TEXT NOT NULL DEFAULT '',
    agent_model TEXT NOT NULL DEFAULT '',
    relationship TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promises (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    due_at INTEGER,
    updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS self_history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    topic_id TEXT,
    ts INTEGER NOT NULL
);
"#;

impl MemoryDb {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT OR IGNORE INTO relation_card (id) VALUES (1)",
            [],
        )?;
        Ok(Self { conn })
    }

    // ───────────────────────── topics ─────────────────────────

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

    // ───────────────────────── events ─────────────────────────

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

    // ───────────────────────── relation card ─────────────────────────

    pub fn get_card(&self) -> rusqlite::Result<RelationCard> {
        self.conn.query_row(
            "SELECT profile, agent_model, relationship, updated_at FROM relation_card WHERE id = 1",
            [],
            card_from_row,
        )
    }

    pub fn update_card(&self, facts: &Value) -> rusqlite::Result<()> {
        let mut card = self.get_card()?;
        let mut changed = false;
        for key in ["profile", "agent_model", "relationship"] {
            let Some(val) = facts.get(key).and_then(|v| v.as_str()) else {
                continue;
            };
            let trimmed = val.trim();
            if trimmed.is_empty() {
                continue;
            }
            let old = match key {
                "profile" => &mut card.profile,
                "agent_model" => &mut card.agent_model,
                _ => &mut card.relationship,
            };
            if old.contains(trimmed) {
                continue;
            }
            if old.is_empty() {
                *old = format!("- {trimmed}");
            } else {
                *old = format!("{old}\n- {trimmed}");
            }
            let len = old.chars().count();
            if len > 1200 {
                let skip = len - 1200;
                *old = old.chars().skip(skip).collect();
            }
            changed = true;
        }
        if changed {
            card.updated_at = now_ms();
            self.conn.execute(
                "UPDATE relation_card SET profile = ?1, agent_model = ?2, relationship = ?3, updated_at = ?4 WHERE id = 1",
                params![card.profile, card.agent_model, card.relationship, card.updated_at],
            )?;
        }
        Ok(())
    }

    // ───────────────────────── promises ─────────────────────────

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

    // ───────────────────────── self-history ─────────────────────────

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
        Ok(Stats {
            total: topics.len(),
            by_tier,
            top,
            events: events as usize,
            open_promises: open_promises as usize,
        })
    }

    pub fn snapshot(&self) -> rusqlite::Result<Snapshot> {
        self.decay_all()?;
        Ok(Snapshot {
            card: self.get_card()?,
            topics: self.list_topics()?,
            promises: self.list_promises(None)?,
            events: self.today_events()?,
        })
    }
}

// ───────────────────────── 工具函数 ─────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id(prefix: &str) -> String {
    let ts = now_ms();
    let seq = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{ts:x}-{seq:x}")
}

fn decay(row: &mut TopicRow, now: i64) -> bool {
    let rule = DECAY_RULES
        .iter()
        .find(|(t, _, _)| *t == row.tier.as_str())
        .copied()
        .unwrap_or(("trivia", 0.15, 0.1));
    let days = ((now - row.last_discussed_at) as f64 / DAY_MS as f64).max(0.0);
    row.weight = (row.weight - rule.1 * days).max(0.0);
    row.weight < rule.2
}

fn topic_from_row(row: &Row) -> rusqlite::Result<TopicRow> {
    let aliases: String = row.get("aliases")?;
    let aliases: Vec<String> = serde_json::from_str(&aliases).unwrap_or_default();
    Ok(TopicRow {
        id: row.get("id")?,
        canonical_name: row.get("canonical_name")?,
        aliases,
        state_summary: row.get("state_summary")?,
        weight: row.get("weight")?,
        tier: row.get("tier")?,
        activation_count: row.get("activation_count")?,
        created_at: row.get("created_at")?,
        last_discussed_at: row.get("last_discussed_at")?,
        n_times: row.get("n_times")?,
        uncertain: row.get::<_, i64>("uncertain")? != 0,
        demoted_at: row.get("demoted_at")?,
        demoted_reason: row.get("demoted_reason")?,
    })
}

fn event_from_row(row: &Row) -> rusqlite::Result<MemoryEvent> {
    Ok(MemoryEvent {
        seq: row.get("seq")?,
        topic_id: row.get("topic_id")?,
        statement: row.get("statement")?,
        ts: row.get("ts")?,
        episode_id: row.get("episode_id")?,
    })
}

fn card_from_row(row: &Row) -> rusqlite::Result<RelationCard> {
    Ok(RelationCard {
        profile: row.get("profile")?,
        agent_model: row.get("agent_model")?,
        relationship: row.get("relationship")?,
        updated_at: row.get("updated_at")?,
    })
}

fn promise_from_row(row: &Row) -> rusqlite::Result<PromiseRow> {
    Ok(PromiseRow {
        id: row.get("id")?,
        content: row.get("content")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        due_at: row.get("due_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn action_from_row(row: &Row) -> rusqlite::Result<SelfAction> {
    Ok(SelfAction {
        id: row.get("id")?,
        kind: row.get("kind")?,
        content: row.get("content")?,
        topic_id: row.get("topic_id")?,
        ts: row.get("ts")?,
    })
}
