//! 行 / 快照结构体。

use serde::Serialize;

// ───────────────────────── 主题 / 事件 / 关系 ─────────────────────────

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
    /// 记忆作用域：owner / global / group:<id> / private:<id>。
    pub scope: String,
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
    /// 名字（`None` = 未命名）：人格卡片是名字权威源，壳层 update_card 后写回实例清单。
    pub name: Option<String>,
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

// ───────────────────────── 好奇心清单 ─────────────────────────

/// 一条待探索条目。`score` 只在 `curiosity_pick` 里计算，其他读面为 0。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuriosityRow {
    pub id: String,
    pub term: String,
    pub dedupe_key: String,
    /// chat:group:<id> / note:<scope> / entity / subscription:<id> / topic / manual
    pub source: String,
    /// chat_mention / note_pending / entity / release / watch / topic_* / fallback
    pub reason: String,
    pub priority: f64,
    /// open / claimed / done / skipped / expired
    pub status: String,
    pub occurrences: i64,
    pub attempts: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_seen_at: i64,
    pub last_attempt_at: Option<i64>,
    pub done_at: Option<i64>,
    pub topic_id: Option<String>,
    /// 完成时写入的一句话结论（汇报素材）。
    pub note: String,
    /// 订阅预先抓到、可直接消费的原文。
    pub payload: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CuriosityCounts {
    pub open: i64,
    pub claimed: i64,
    pub done: i64,
    pub skipped: i64,
    pub expired: i64,
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
