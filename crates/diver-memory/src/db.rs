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

/// snapshot 视图缓存的最近条数上限（topics 与 events 各一份；card/promises 保持全量）。
pub const SNAPSHOT_DEFAULT_LIMIT: usize = 200;
/// events 表最多保留的最近事件数（超出后按 seq 裁剪最旧记录）。
const MAX_EVENTS: i64 = 2000;

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
    pub entities: usize,
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

// ───────────────────────── 实体图谱类型 ─────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRow {
    pub id: String,
    pub name: String,
    pub entity_type: Option<String>,
    pub mention_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityAttrRow {
    pub id: String,
    pub entity_id: String,
    pub attr_key: String,
    pub attr_value: String,
    pub valid_from: i64,
    pub valid_until: Option<i64>,
    pub source_topic_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRelationRow {
    pub id: String,
    pub from_entity_id: String,
    pub to_entity_id: String,
    pub relation: String,
    pub source_topic_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityNeighbor {
    pub relation: String,
    /// "out" = 从本实体指出；"in" = 指向本实体
    pub direction: String,
    pub entity: EntityRow,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityGraph {
    pub entity: EntityRow,
    pub attrs: Vec<EntityAttrRow>,
    pub neighbors: Vec<EntityNeighbor>,
}

/// 一次显式声明的实体关系（to 侧可带类型，不存在则创建）。
#[derive(Debug, Clone)]
pub struct RelationSpec {
    pub to_name: String,
    pub relation: String,
    pub to_type: Option<String>,
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

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    entity_type TEXT,
    mention_count INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

CREATE TABLE IF NOT EXISTS entity_attrs (
    id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    attr_key TEXT NOT NULL,
    attr_value TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_until INTEGER,
    source_topic_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_attrs_entity ON entity_attrs(entity_id, attr_key);

CREATE TABLE IF NOT EXISTS entity_relations (
    id TEXT PRIMARY KEY,
    from_entity_id TEXT NOT NULL,
    to_entity_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    source_topic_id TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_rel_from ON entity_relations(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_rel_to ON entity_relations(to_entity_id);
"#;

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

    // ───────────────────────── 实体图谱 ─────────────────────────
    // 写入一律由 agent / digest 显式声明（不做规则抽取），挂在 topics 旁。

    pub fn upsert_entity(&self, name: &str, entity_type: Option<&str>) -> rusqlite::Result<EntityRow> {
        let name = name.trim();
        let now = now_ms();
        if let Some(mut row) = self.find_entity(name)? {
            row.mention_count += 1;
            row.updated_at = now;
            if row.entity_type.is_none() {
                if let Some(t) = entity_type.map(str::trim).filter(|t| !t.is_empty()) {
                    row.entity_type = Some(t.to_string());
                }
            }
            self.conn.execute(
                "UPDATE entities SET mention_count = ?1, updated_at = ?2, entity_type = ?3 WHERE id = ?4",
                params![row.mention_count, row.updated_at, row.entity_type, row.id],
            )?;
            return Ok(row);
        }
        let id = new_id("e");
        let et = entity_type.map(str::trim).filter(|t| !t.is_empty()).map(str::to_string);
        self.conn.execute(
            "INSERT INTO entities (id, name, entity_type, mention_count, created_at, updated_at) VALUES (?1, ?2, ?3, 1, ?4, ?4)",
            params![id, name, et, now],
        )?;
        Ok(EntityRow {
            id,
            name: name.to_string(),
            entity_type: et,
            mention_count: 1,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn find_entity(&self, name: &str) -> rusqlite::Result<Option<EntityRow>> {
        self.conn
            .query_row(
                "SELECT id, name, entity_type, mention_count, created_at, updated_at FROM entities WHERE name = ?1",
                params![name.trim()],
                entity_from_row,
            )
            .optional()
    }

    pub fn find_entity_by_id(&self, id: &str) -> rusqlite::Result<Option<EntityRow>> {
        self.conn
            .query_row(
                "SELECT id, name, entity_type, mention_count, created_at, updated_at FROM entities WHERE id = ?1",
                params![id],
                entity_from_row,
            )
            .optional()
    }

    /// 时序属性：同 key 旧值封存（valid_until），写入新当前值。与当前值相同则跳过。
    pub fn set_entity_attr(
        &self,
        entity_id: &str,
        key: &str,
        value: &str,
        source_topic_id: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            return Ok(false);
        }
        let now = now_ms();
        let current: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT id, attr_value FROM entity_attrs WHERE entity_id = ?1 AND attr_key = ?2 AND valid_until IS NULL",
                params![entity_id, key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((_, old)) = current {
            if old == value {
                return Ok(false);
            }
            self.conn.execute(
                "UPDATE entity_attrs SET valid_until = ?1 WHERE entity_id = ?2 AND attr_key = ?3 AND valid_until IS NULL",
                params![now, entity_id, key],
            )?;
        }
        self.conn.execute(
            "INSERT INTO entity_attrs (id, entity_id, attr_key, attr_value, valid_from, valid_until, source_topic_id, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?5)",
            params![new_id("ea"), entity_id, key, value, now, source_topic_id],
        )?;
        self.conn.execute(
            "UPDATE entities SET updated_at = ?1 WHERE id = ?2",
            params![now, entity_id],
        )?;
        Ok(true)
    }

    pub fn current_entity_attrs(&self, entity_id: &str) -> rusqlite::Result<Vec<EntityAttrRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, entity_id, attr_key, attr_value, valid_from, valid_until, source_topic_id \
             FROM entity_attrs WHERE entity_id = ?1 AND valid_until IS NULL ORDER BY attr_key",
        )?;
        let rows = stmt.query_map(params![entity_id], entity_attr_from_row)?;
        rows.collect()
    }

    /// 同 from/to/relation 已存在则跳过（幂等）。
    pub fn add_entity_relation(
        &self,
        from_entity_id: &str,
        to_entity_id: &str,
        relation: &str,
        source_topic_id: Option<&str>,
    ) -> rusqlite::Result<bool> {
        let relation = relation.trim();
        if relation.is_empty() || from_entity_id == to_entity_id {
            return Ok(false);
        }
        let exists: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM entity_relations WHERE from_entity_id = ?1 AND to_entity_id = ?2 AND relation = ?3",
                params![from_entity_id, to_entity_id, relation],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Ok(false);
        }
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO entity_relations (id, from_entity_id, to_entity_id, relation, source_topic_id, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![new_id("er"), from_entity_id, to_entity_id, relation, source_topic_id, now],
        )?;
        Ok(true)
    }

    /// 显式声明一条实体图谱事实：upsert 主实体 + 属性 + 出边关系（to 侧自动创建）。
    pub fn upsert_entity_graph(
        &self,
        name: &str,
        entity_type: Option<&str>,
        attrs: &[(String, String)],
        relations: &[RelationSpec],
        source_topic_id: Option<&str>,
    ) -> rusqlite::Result<EntityGraph> {
        let entity = self.upsert_entity(name, entity_type)?;
        for (k, v) in attrs {
            self.set_entity_attr(&entity.id, k, v, source_topic_id)?;
        }
        for rel in relations {
            let to = self.upsert_entity(&rel.to_name, rel.to_type.as_deref())?;
            self.add_entity_relation(&entity.id, &to.id, &rel.relation, source_topic_id)?;
        }
        self.entity_graph_by_id(&entity.id, 1)
    }

    pub fn entity_graph(&self, name: &str, hops: Option<usize>) -> rusqlite::Result<Option<EntityGraph>> {
        let Some(entity) = self.find_entity(name)? else {
            return Ok(None);
        };
        Ok(Some(self.entity_graph_by_id(&entity.id, hops.unwrap_or(1))?))
    }

    pub fn entity_graph_by_id(&self, id: &str, hops: usize) -> rusqlite::Result<EntityGraph> {
        let Some(entity) = self.find_entity_by_id(id)? else {
            return Err(rusqlite::Error::QueryReturnedNoRows);
        };
        let attrs = self.current_entity_attrs(id)?;
        let mut neighbors = self.neighbor_edges(id)?;
        if hops >= 2 {
            let mut seen: std::collections::BTreeSet<String> = neighbors
                .iter()
                .map(|n| n.entity.id.clone())
                .collect();
            seen.insert(id.to_string());
            let frontier: Vec<String> = seen.iter().cloned().collect();
            for nid in frontier {
                for n in self.neighbor_edges(&nid)? {
                    if seen.insert(n.entity.id.clone()) {
                        neighbors.push(n);
                    }
                }
            }
        }
        Ok(EntityGraph { entity, attrs, neighbors })
    }

    fn neighbor_edges(&self, id: &str) -> rusqlite::Result<Vec<EntityNeighbor>> {
        let mut out = Vec::new();
        let mut stmt = self.conn.prepare(
            "SELECT r.relation, e.id, e.name, e.entity_type, e.mention_count, e.created_at, e.updated_at \
             FROM entity_relations r JOIN entities e ON e.id = r.to_entity_id \
             WHERE r.from_entity_id = ?1 ORDER BY r.created_at DESC",
        )?;
        for row in stmt.query_map(params![id], |r| {
            Ok(EntityNeighbor {
                relation: r.get(0)?,
                direction: "out".to_string(),
                entity: entity_cols(r, 1)?,
            })
        })? {
            out.push(row?);
        }
        let mut stmt = self.conn.prepare(
            "SELECT r.relation, e.id, e.name, e.entity_type, e.mention_count, e.created_at, e.updated_at \
             FROM entity_relations r JOIN entities e ON e.id = r.from_entity_id \
             WHERE r.to_entity_id = ?1 ORDER BY r.created_at DESC",
        )?;
        for row in stmt.query_map(params![id], |r| {
            Ok(EntityNeighbor {
                relation: r.get(0)?,
                direction: "in".to_string(),
                entity: entity_cols(r, 1)?,
            })
        })? {
            out.push(row?);
        }
        Ok(out)
    }

    /// recall 用：文本命中的实体 + 一跳邻域（多跳召回原料）。
    pub fn entity_candidates(&self, text: &str, limit: Option<usize>) -> rusqlite::Result<Vec<EntityGraph>> {
        let limit = limit.unwrap_or(5).max(1);
        if text.trim().is_empty() {
            return Ok(vec![]);
        }
        let mut hits = Vec::new();
        for row in self.list_entities(None)? {
            if row.name.chars().count() >= 2 && text.contains(&row.name) {
                hits.push(row);
            }
        }
        hits.sort_by(|a, b| b.name.chars().count().cmp(&a.name.chars().count()));
        hits.truncate(limit);
        hits.into_iter()
            .map(|e| self.entity_graph_by_id(&e.id, 1))
            .collect()
    }

    pub fn list_entities(&self, limit: Option<usize>) -> rusqlite::Result<Vec<EntityRow>> {
        match limit {
            Some(n) => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, name, entity_type, mention_count, created_at, updated_at \
                     FROM entities ORDER BY updated_at DESC LIMIT ?1",
                )?;
                let rows = stmt.query_map(params![n as i64], entity_from_row)?;
                rows.collect()
            }
            None => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, name, entity_type, mention_count, created_at, updated_at \
                     FROM entities ORDER BY updated_at DESC",
                )?;
                let rows = stmt.query_map([], entity_from_row)?;
                rows.collect()
            }
        }
    }

    pub fn search_entities(&self, text: &str, limit: Option<usize>) -> rusqlite::Result<Vec<EntityRow>> {
        let limit = limit.unwrap_or(10).max(1) as i64;
        let pattern = format!("%{}%", text.trim());
        let mut stmt = self.conn.prepare(
            "SELECT id, name, entity_type, mention_count, created_at, updated_at \
             FROM entities WHERE name LIKE ?1 ORDER BY mention_count DESC, updated_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], entity_from_row)?;
        rows.collect()
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

    fn recent_topics(&self, limit: usize) -> rusqlite::Result<Vec<TopicRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM topics ORDER BY last_discussed_at DESC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit as i64], topic_from_row)?;
        rows.collect()
    }

    fn recent_events(&self, limit: usize) -> rusqlite::Result<Vec<MemoryEvent>> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, topic_id, statement, ts, episode_id FROM events ORDER BY seq DESC LIMIT ?1")?;
        let mut rows: Vec<MemoryEvent> = stmt.query_map(params![limit as i64], event_from_row)?.collect::<rusqlite::Result<_>>()?;
        rows.reverse();
        Ok(rows)
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

fn entity_from_row(row: &Row) -> rusqlite::Result<EntityRow> {
    Ok(EntityRow {
        id: row.get("id")?,
        name: row.get("name")?,
        entity_type: row.get("entity_type")?,
        mention_count: row.get("mention_count")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 从 JOIN 结果的 offset 列开始读实体六元组。
fn entity_cols(row: &Row, offset: usize) -> rusqlite::Result<EntityRow> {
    Ok(EntityRow {
        id: row.get(offset)?,
        name: row.get(offset + 1)?,
        entity_type: row.get(offset + 2)?,
        mention_count: row.get(offset + 3)?,
        created_at: row.get(offset + 4)?,
        updated_at: row.get(offset + 5)?,
    })
}

fn entity_attr_from_row(row: &Row) -> rusqlite::Result<EntityAttrRow> {
    Ok(EntityAttrRow {
        id: row.get("id")?,
        entity_id: row.get("entity_id")?,
        attr_key: row.get("attr_key")?,
        attr_value: row.get("attr_value")?,
        valid_from: row.get("valid_from")?,
        valid_until: row.get("valid_until")?,
        source_topic_id: row.get("source_topic_id")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn mem_db() -> MemoryDb {
        MemoryDb::open(Path::new(":memory:")).unwrap()
    }

    #[test]
    fn upsert_entity_graph_writes_attrs_and_relations() {
        let db = mem_db();
        let g = db
            .upsert_entity_graph(
                "用户",
                Some("person"),
                &[("忌口".to_string(), "香菜".to_string())],
                &[RelationSpec {
                    to_name: "小明".to_string(),
                    relation: "同事".to_string(),
                    to_type: Some("person".to_string()),
                }],
                None,
            )
            .unwrap();
        assert_eq!(g.entity.name, "用户");
        assert_eq!(g.attrs.len(), 1);
        assert_eq!(g.attrs[0].attr_value, "香菜");
        assert_eq!(g.neighbors.len(), 1);
        assert_eq!(g.neighbors[0].entity.name, "小明");
        assert_eq!(g.neighbors[0].relation, "同事");
    }

    #[test]
    fn attr_is_versioned_and_relation_idempotent() {
        let db = mem_db();
        let e = db.upsert_entity("吉他", Some("habit")).unwrap();
        assert!(db.set_entity_attr(&e.id, "进度", "入门", None).unwrap());
        assert!(!db.set_entity_attr(&e.id, "进度", "入门", None).unwrap());
        assert!(db.set_entity_attr(&e.id, "进度", "能弹小星星", None).unwrap());
        let attrs = db.current_entity_attrs(&e.id).unwrap();
        assert_eq!(attrs.len(), 1);
        assert_eq!(attrs[0].attr_value, "能弹小星星");

        let u = db.upsert_entity("用户", None).unwrap();
        assert!(db.add_entity_relation(&u.id, &e.id, "在学", None).unwrap());
        assert!(!db.add_entity_relation(&u.id, &e.id, "在学", None).unwrap());
    }

    #[test]
    fn entity_candidates_match_name_in_text() {
        let db = mem_db();
        db.upsert_entity_graph(
            "小明",
            Some("person"),
            &[("职业".to_string(), "设计师".to_string())],
            &[RelationSpec {
                to_name: "李雷".to_string(),
                relation: "同事".to_string(),
                to_type: None,
            }],
            None,
        )
        .unwrap();
        let hits = db.entity_candidates("小明最近换工作了吗", Some(5)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entity.name, "小明");
        assert!(hits[0].attrs.iter().any(|a| a.attr_key == "职业"));
        let empty = db.entity_candidates("完全无关的话题", Some(5)).unwrap();
        assert!(empty.is_empty());
    }
}
