//! 好奇心清单：待探索条目的持久队列、去重、评分与生命周期。
//!
//! 来源（群聊 / 笔记 / 实体 / 订阅）由 sidecar 决定，本模块只做确定性存储：
//! - `dedupe_key` 唯一：同一词只入队一次，release/watch 用外部稳定 id
//! - 评分 = priority × 出现次数 × 7 天半衰期 × 尝试惩罚
//! - open → claimed → done / open（失败重试，3 次后 skipped）
//! - open 超 30 天 expired，done/skipped/expired 超 90 天清理

use rusqlite::{params, OptionalExtension};

use super::mappers::curiosity_from_row;
use super::types::{CuriosityCounts, CuriosityRow};
use super::util::{new_id, now_ms, DAY_MS};
use super::MemoryDb;

/// 队列开放上限（open + claimed）。超出时淘汰最低优先级的最旧条目。
const OPEN_CAP: i64 = 300;
/// 未探索条目保留 30 天，过期后不再被 pick。
const OPEN_EXPIRE_MS: i64 = 30 * DAY_MS;
/// 已结束条目保留 90 天（汇报查询与排查用）。
const FINISHED_RETAIN_MS: i64 = 90 * DAY_MS;
/// 同一条目两次尝试之间的最小间隔。
const ATTEMPT_BACKOFF_MS: i64 = 12 * 3600_000;
/// claimed 超过这个时长仍未结束（sidecar 崩溃/重启）→ 回收为 open。
const STALE_CLAIM_MS: i64 = 30 * 60_000;
/// 失败重试上限；达到后自动 skipped。
const MAX_ATTEMPTS: i64 = 3;
/// 评分用的出现次数/尝试次数上限（防单条刷分）。
const MAX_OCCURRENCES: f64 = 3.0;
const MAX_ATTEMPTS_PENALTY: i64 = 3;

/// 条目评分（纯函数，单测覆盖）。时间越久、尝试越多分数越低。
pub(super) fn curiosity_score(
    priority: f64,
    occurrences: i64,
    last_seen_at: i64,
    attempts: i64,
    now: i64,
) -> f64 {
    let age = (now - last_seen_at).max(0) as f64;
    let half_life = 7.0 * DAY_MS as f64;
    let recency = 0.5f64.powf(age / half_life);
    let occ = 1.0 + (occurrences.max(1) as f64).ln().min(MAX_OCCURRENCES);
    let retry = 1.0 - 0.2 * attempts.clamp(0, MAX_ATTEMPTS_PENALTY) as f64;
    (priority.max(0.0) * occ * recency * retry).max(0.0)
}

/// 缺省去重键：归一化词面（小写、压缩空白）。
pub(super) fn default_dedupe_key(term: &str) -> String {
    let lower = term.trim().to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut space = false;
    for ch in lower.chars() {
        if ch.is_whitespace() {
            if !space && !out.is_empty() {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(ch);
            space = false;
        }
    }
    out.trim_end().to_string()
}

impl MemoryDb {
    /// 入队 / 合并。已有条目只累加出现次数与优先级；已完成的不再重开。
    pub fn curiosity_upsert(
        &self,
        term: &str,
        dedupe_key: Option<&str>,
        source: &str,
        reason: &str,
        priority: f64,
        note: Option<&str>,
        payload: Option<&str>,
    ) -> rusqlite::Result<String> {
        let term = term.trim();
        let key = dedupe_key
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| default_dedupe_key(term));
        if term.is_empty() || key.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName("term".into()));
        }
        let now = now_ms();
        let priority = priority.max(0.0);
        let note = note.unwrap_or("").trim();
        let payload = payload.unwrap_or("").trim();

        if let Some((id, status, old_priority)) = self
            .conn
            .query_row(
                "SELECT id, status, priority FROM curiosity_items WHERE dedupe_key = ?1",
                params![key],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, f64>(2)?,
                    ))
                },
            )
            .optional()?
        {
            if status == "done" || status == "skipped" {
                return Ok(id);
            }
            self.prune_curiosity(now)?;
            self.conn.execute(
                "UPDATE curiosity_items SET \
                 term = ?1, source = ?2, reason = ?3, priority = ?4, \
                 status = CASE WHEN status = 'claimed' THEN 'claimed' ELSE 'open' END, \
                 occurrences = occurrences + 1, last_seen_at = ?5, updated_at = ?5, \
                 note = CASE WHEN ?6 <> '' THEN ?6 ELSE note END, \
                 payload = CASE WHEN ?7 <> '' THEN ?7 ELSE payload END \
                 WHERE id = ?8",
                params![
                    term,
                    source,
                    reason,
                    priority.max(old_priority),
                    now,
                    note,
                    payload,
                    id
                ],
            )?;
            return Ok(id);
        }

        self.prune_curiosity(now)?;
        let open: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM curiosity_items WHERE status IN ('open','claimed')",
            [],
            |r| r.get(0),
        )?;
        if open >= OPEN_CAP {
            // 队列满：淘汰最低优先级、最久未出现的一条 open，避免无界增长。
            self.conn.execute(
                "DELETE FROM curiosity_items WHERE id = ( \
                   SELECT id FROM curiosity_items WHERE status = 'open' \
                   ORDER BY priority ASC, last_seen_at ASC LIMIT 1)",
                [],
            )?;
        }
        let id = new_id("c");
        self.conn.execute(
            "INSERT INTO curiosity_items \
             (id, term, dedupe_key, source, reason, priority, status, occurrences, attempts, \
              created_at, updated_at, last_seen_at, last_attempt_at, done_at, topic_id, note, payload) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', 1, 0, ?7, ?7, ?7, NULL, NULL, NULL, ?8, ?9)",
            params![id, term, key, source, reason, priority, now, note, payload],
        )?;
        Ok(id)
    }

    pub fn curiosity_get(&self, id: &str) -> rusqlite::Result<Option<CuriosityRow>> {
        self.conn
            .query_row(
                "SELECT * FROM curiosity_items WHERE id = ?1",
                params![id],
                curiosity_from_row,
            )
            .optional()
    }

    /// 可选条目：按评分降序，跳过仍在重试退避期的条目。
    pub fn curiosity_pick(&self, limit: Option<usize>, now: i64) -> rusqlite::Result<Vec<CuriosityRow>> {
        self.prune_curiosity(now)?;
        let limit = limit.unwrap_or(5).clamp(1, 50);
        let mut stmt = self.conn.prepare(
            "SELECT * FROM curiosity_items WHERE status = 'open' \
             AND (last_attempt_at IS NULL OR ?1 - last_attempt_at >= ?2) \
             ORDER BY last_seen_at DESC LIMIT 500",
        )?;
        let rows = stmt.query_map(params![now, ATTEMPT_BACKOFF_MS], curiosity_from_row)?;
        let mut items = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        for item in &mut items {
            item.score = curiosity_score(
                item.priority,
                item.occurrences,
                item.last_seen_at,
                item.attempts,
                now,
            );
        }
        items.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        items.truncate(limit);
        Ok(items)
    }

    pub fn curiosity_list(
        &self,
        status: Option<&str>,
        limit: Option<usize>,
    ) -> rusqlite::Result<Vec<CuriosityRow>> {
        let limit = limit.unwrap_or(50).clamp(1, 500);
        match status.map(str::trim).filter(|s| !s.is_empty()) {
            Some(status) => {
                let mut stmt = self.conn.prepare(
                    "SELECT * FROM curiosity_items WHERE status = ?1 \
                     ORDER BY last_seen_at DESC LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![status, limit], curiosity_from_row)?;
                rows.collect()
            }
            None => {
                let mut stmt = self.conn.prepare(
                    "SELECT * FROM curiosity_items ORDER BY last_seen_at DESC LIMIT ?1",
                )?;
                let rows = stmt.query_map(params![limit], curiosity_from_row)?;
                rows.collect()
            }
        }
    }

    /// 占用条目；`attempts` 在 claim 时递增（失败/取消由 release 退回）。
    pub fn curiosity_claim(&self, id: &str, now: i64) -> rusqlite::Result<bool> {
        let changed = self.conn.execute(
            "UPDATE curiosity_items SET status = 'claimed', attempts = attempts + 1, \
             last_attempt_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'open'",
            params![now, id],
        )?;
        Ok(changed > 0)
    }

    /// 释放失败/取消的条目：未到重试上限回到 open，否则 skipped。
    /// `reset_attempt`：用户聊天打断（非失败）不消耗重试次数。
    pub fn curiosity_release(
        &self,
        id: &str,
        now: i64,
        reset_attempt: bool,
    ) -> rusqlite::Result<bool> {
        let Some((status, attempts)) = self
            .conn
            .query_row(
                "SELECT status, attempts FROM curiosity_items WHERE id = ?1",
                params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()?
        else {
            return Ok(false);
        };
        if status != "claimed" {
            return Ok(false);
        }
        let attempts = if reset_attempt {
            attempts.saturating_sub(1).max(0)
        } else {
            attempts
        };
        let next_status = if attempts >= MAX_ATTEMPTS { "skipped" } else { "open" };
        self.conn.execute(
            "UPDATE curiosity_items SET status = ?1, attempts = ?2, updated_at = ?3 WHERE id = ?4",
            params![next_status, attempts, now, id],
        )?;
        Ok(true)
    }

    /// 完成：落库 topic 关联 + 一句话结论（汇报素材）。
    pub fn curiosity_complete(
        &self,
        id: &str,
        topic_id: Option<&str>,
        note: Option<&str>,
        now: i64,
    ) -> rusqlite::Result<bool> {
        let note = note.unwrap_or("").trim();
        let changed = self.conn.execute(
            "UPDATE curiosity_items SET status = 'done', done_at = ?1, updated_at = ?1, \
             topic_id = COALESCE(?2, topic_id), \
             note = CASE WHEN ?3 <> '' THEN ?3 ELSE note END \
             WHERE id = ?4 AND status IN ('open','claimed')",
            params![now, topic_id, note, id],
        )?;
        Ok(changed > 0)
    }

    /// 汇报用：某时刻之后完成的条目（新→旧）。
    pub fn curiosity_done_since(&self, since: i64, limit: Option<usize>) -> rusqlite::Result<Vec<CuriosityRow>> {
        let limit = limit.unwrap_or(10).clamp(1, 100);
        let mut stmt = self.conn.prepare(
            "SELECT * FROM curiosity_items WHERE status = 'done' AND done_at IS NOT NULL \
             AND done_at >= ?1 ORDER BY done_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![since, limit], curiosity_from_row)?;
        rows.collect()
    }

    pub fn curiosity_counts(&self) -> rusqlite::Result<CuriosityCounts> {
        let mut stmt = self.conn.prepare(
            "SELECT \
               SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), \
               SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END), \
               SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), \
               SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), \
               SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) \
             FROM curiosity_items",
        )?;
        let counts = stmt.query_row([], |r| {
            Ok(CuriosityCounts {
                open: r.get::<_, Option<i64>>(0)?.unwrap_or(0),
                claimed: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                done: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                skipped: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                expired: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
            })
        })?;
        Ok(counts)
    }

    /// 生命周期清理：open 超期 → expired；结束态超期 → 删除。
    pub(super) fn prune_curiosity(&self, now: i64) -> rusqlite::Result<()> {
        // 崩溃/重启留下的 claimed：job 生命周期只有几分钟，30 分钟未结束即回收。
        self.conn.execute(
            "UPDATE curiosity_items SET status = 'open', updated_at = ?1 \
             WHERE status = 'claimed' AND last_attempt_at IS NOT NULL AND last_attempt_at < ?1 - ?2",
            params![now, STALE_CLAIM_MS],
        )?;
        self.conn.execute(
            "UPDATE curiosity_items SET status = 'expired', updated_at = ?1 \
             WHERE status = 'open' AND created_at < ?1 - ?2",
            params![now, OPEN_EXPIRE_MS],
        )?;
        self.conn.execute(
            "DELETE FROM curiosity_items WHERE status IN ('done','skipped','expired') \
             AND updated_at < ?1 - ?2",
            params![now, FINISHED_RETAIN_MS],
        )?;
        Ok(())
    }
}
