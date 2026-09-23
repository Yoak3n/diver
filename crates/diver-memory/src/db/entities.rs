//! 实体图谱：实体 / 时序属性 / 关系 / 多跳邻域。
//! 写入一律由 agent / digest 显式声明（不做规则抽取），挂在 topics 旁。

use rusqlite::{params, OptionalExtension};

use super::mappers::{entity_attr_from_row, entity_cols, entity_from_row};
use super::types::{
    EntityAttrRow, EntityGraph, EntityNeighbor, EntityRow, RelationSpec,
};
use super::util::{new_id, now_ms};
use super::MemoryDb;

impl MemoryDb {
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
}
