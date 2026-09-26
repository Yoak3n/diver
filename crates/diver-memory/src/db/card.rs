//! 关系卡片读写。

use rusqlite::params;
use serde_json::Value;

use super::mappers::card_from_row;
use super::types::RelationCard;
use super::util::now_ms;
use super::MemoryDb;

impl MemoryDb {
    pub fn get_card(&self) -> rusqlite::Result<RelationCard> {
        self.conn.query_row(
            "SELECT name, profile, agent_model, relationship, updated_at FROM relation_card WHERE id = 1",
            [],
            card_from_row,
        )
    }

    pub fn update_card(&self, facts: &Value) -> rusqlite::Result<()> {
        let mut card = self.get_card()?;
        let mut changed = false;
        // name 是标量覆盖语义（实例名回填的权威源），区别于 profile 等追加式字段；
        // 可选字段：非空 = 覆盖改名，空串/缺省 = 不修改（清空回未命名只发生在实例清单侧）。
        if let Some(val) = facts.get("name").and_then(|v| v.as_str()) {
            let trimmed = val.trim();
            if !trimmed.is_empty() && card.name.as_deref() != Some(trimmed) {
                card.name = Some(trimmed.to_string());
                changed = true;
            }
        }
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
                "UPDATE relation_card SET name = ?1, profile = ?2, agent_model = ?3, relationship = ?4, updated_at = ?5 WHERE id = 1",
                params![card.name, card.profile, card.agent_model, card.relationship, card.updated_at],
            )?;
        }
        Ok(())
    }
}
