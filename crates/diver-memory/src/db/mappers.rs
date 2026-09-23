//! rusqlite 行 → 领域类型。

use rusqlite::Row;

use super::types::{
    EntityAttrRow, EntityRow, MemoryEvent, PromiseRow, RelationCard, SelfAction, TopicRow,
};

pub(super) fn topic_from_row(row: &Row) -> rusqlite::Result<TopicRow> {
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

pub(super) fn event_from_row(row: &Row) -> rusqlite::Result<MemoryEvent> {
    Ok(MemoryEvent {
        seq: row.get("seq")?,
        topic_id: row.get("topic_id")?,
        statement: row.get("statement")?,
        ts: row.get("ts")?,
        episode_id: row.get("episode_id")?,
    })
}

pub(super) fn card_from_row(row: &Row) -> rusqlite::Result<RelationCard> {
    Ok(RelationCard {
        profile: row.get("profile")?,
        agent_model: row.get("agent_model")?,
        relationship: row.get("relationship")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(super) fn promise_from_row(row: &Row) -> rusqlite::Result<PromiseRow> {
    Ok(PromiseRow {
        id: row.get("id")?,
        content: row.get("content")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        due_at: row.get("due_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub(super) fn action_from_row(row: &Row) -> rusqlite::Result<SelfAction> {
    Ok(SelfAction {
        id: row.get("id")?,
        kind: row.get("kind")?,
        content: row.get("content")?,
        topic_id: row.get("topic_id")?,
        ts: row.get("ts")?,
    })
}

pub(super) fn entity_from_row(row: &Row) -> rusqlite::Result<EntityRow> {
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
pub(super) fn entity_cols(row: &Row, offset: usize) -> rusqlite::Result<EntityRow> {
    Ok(EntityRow {
        id: row.get(offset)?,
        name: row.get(offset + 1)?,
        entity_type: row.get(offset + 2)?,
        mention_count: row.get(offset + 3)?,
        created_at: row.get(offset + 4)?,
        updated_at: row.get(offset + 5)?,
    })
}

pub(super) fn entity_attr_from_row(row: &Row) -> rusqlite::Result<EntityAttrRow> {
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
