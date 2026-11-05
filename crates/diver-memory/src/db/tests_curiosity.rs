//! 好奇心队列：去重、评分、生命周期。

use std::path::Path;

use super::curiosity::{curiosity_score, default_dedupe_key};
use super::util::{now_ms, DAY_MS};
use super::*;

fn mem_db() -> MemoryDb {
    MemoryDb::open(Path::new(":memory:")).unwrap()
}

#[test]
fn dedupe_key_normalizes_case_and_space() {
    assert_eq!(default_dedupe_key("  DeepSeek   V3 "), "deepseek v3");
    assert_eq!(default_dedupe_key("MXene"), "mxene");
    assert_eq!(default_dedupe_key("  "), "");
}

#[test]
fn upsert_merges_occurrences_and_keeps_max_priority() {
    let db = mem_db();
    let id = db
        .curiosity_upsert("MXene", None, "chat:group:1", "chat_mention", 1.0, None, None)
        .unwrap();
    let again = db
        .curiosity_upsert(
            "mxene",
            None,
            "note:owner",
            "note_pending",
            2.5,
            Some("笔记里提过"),
            None,
        )
        .unwrap();
    assert_eq!(id, again, "同一归一化词只入队一次");

    let got = db.curiosity_get(&id).unwrap().expect("按 id 可取回条目");
    assert_eq!(got.term, "mxene");

    let items = db.curiosity_list(None, Some(10)).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].occurrences, 2);
    assert_eq!(items[0].priority, 2.5);
    assert_eq!(items[0].note, "笔记里提过");
    assert_eq!(items[0].source, "note:owner");
}

#[test]
fn done_items_are_not_reopened() {
    let db = mem_db();
    let id = db
        .curiosity_upsert("Rust", None, "entity", "entity", 1.5, None, None)
        .unwrap();
    assert!(db.curiosity_claim(&id, now_ms()).unwrap());
    assert!(db
        .curiosity_complete(&id, Some("t1"), Some("一门语言"), false, now_ms())
        .unwrap());
    db.curiosity_upsert("Rust", None, "entity", "entity", 1.5, None, None)
        .unwrap();
    let items = db.curiosity_list(Some("done"), Some(10)).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].status, "done");
    assert!(db.curiosity_pick(Some(10), now_ms()).unwrap().is_empty());
}

#[test]
fn score_prefers_priority_freshness_and_fewer_attempts() {
    let now = 100 * DAY_MS;
    let high = curiosity_score(2.0, 1, now, 0, now);
    let low = curiosity_score(1.0, 1, now, 0, now);
    assert!(high > low);

    let fresh = curiosity_score(1.0, 1, now, 0, now);
    let stale = curiosity_score(1.0, 1, now - 14 * DAY_MS, 0, now);
    assert!(fresh > stale);

    let retried = curiosity_score(1.0, 1, now, 2, now);
    assert!(fresh > retried);

    let repeated = curiosity_score(1.0, 3, now, 0, now);
    assert!(repeated > fresh, "重复出现应加分");
}

#[test]
fn pick_orders_by_score_and_respects_backoff() {
    let db = mem_db();
    let now = now_ms();
    let low = db
        .curiosity_upsert("low", None, "chat:group:1", "chat_mention", 1.0, None, None)
        .unwrap();
    let high = db
        .curiosity_upsert("high", None, "note:owner", "note_pending", 3.0, None, None)
        .unwrap();
    let picked = db.curiosity_pick(Some(2), now).unwrap();
    assert_eq!(picked[0].id, high);
    assert_eq!(picked[1].id, low);
    assert!(picked[0].score > picked[1].score);

    // claim 后进入 12h 退避，不再被 pick。
    assert!(db.curiosity_claim(&high, now).unwrap());
    let picked = db.curiosity_pick(Some(2), now).unwrap();
    assert_eq!(picked.len(), 1);
    assert_eq!(picked[0].id, low);
}

#[test]
fn release_retries_then_skips() {
    let db = mem_db();
    let id = db
        .curiosity_upsert("retry", None, "entity", "entity", 1.0, None, None)
        .unwrap();
    let now = now_ms();

    for attempt in 1..=3 {
        assert!(db.curiosity_claim(&id, now + attempt).unwrap());
        assert!(db.curiosity_release(&id, now + attempt, false).unwrap());
        let row = db.curiosity_list(None, Some(10)).unwrap().remove(0);
        if attempt < 3 {
            assert_eq!(row.status, "open");
        } else {
            assert_eq!(row.status, "skipped");
        }
    }
}

#[test]
fn cancel_release_does_not_consume_retry_budget() {
    let db = mem_db();
    let id = db
        .curiosity_upsert("被打断", None, "entity", "entity", 1.0, None, None)
        .unwrap();
    let now = now_ms();
    assert!(db.curiosity_claim(&id, now).unwrap());
    assert!(db.curiosity_release(&id, now + 1, true).unwrap());
    let row = db.curiosity_list(None, Some(10)).unwrap().remove(0);
    assert_eq!(row.status, "open");
    assert_eq!(row.attempts, 0, "用户聊天打断不消耗重试次数");
}

#[test]
fn complete_records_topic_note_and_done_since() {
    let db = mem_db();
    let now = now_ms();
    let id = db
        .curiosity_upsert("落地", None, "manual", "manual", 1.0, None, None)
        .unwrap();
    assert!(db.curiosity_claim(&id, now).unwrap());
    assert!(db
        .curiosity_complete(&id, Some("t-9"), Some("一句话结论"), false, now + 1)
        .unwrap());
    let done = db.curiosity_done_since(now, Some(10)).unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].topic_id.as_deref(), Some("t-9"));
    assert_eq!(done[0].note, "一句话结论");

    let counts = db.curiosity_counts().unwrap();
    assert_eq!(counts.done, 1);
    assert_eq!(counts.open, 0);
}

#[test]
fn complete_can_clear_raw_payload() {
    let db = mem_db();
    let now = now_ms();
    let id = db
        .curiosity_upsert(
            "平台见闻",
            None,
            "platform:bilibili",
            "platform_trend",
            1.8,
            None,
            Some("原始评论/弹幕正文"),
        )
        .unwrap();
    assert!(db.curiosity_claim(&id, now).unwrap());
    assert!(db
        .curiosity_complete(&id, Some("t1"), Some("结论"), true, now + 1)
        .unwrap());
    let row = db.curiosity_get(&id).unwrap().unwrap();
    assert_eq!(row.payload, "", "完成后原始 payload 应清空");
    assert_eq!(row.note, "结论");
}

#[test]
fn stale_claimed_item_is_recycled() {
    let db = mem_db();
    let id = db
        .curiosity_upsert("崩溃残留", None, "entity", "entity", 1.0, None, None)
        .unwrap();
    let now = now_ms();
    assert!(db.curiosity_claim(&id, now).unwrap());
    db.conn
        .execute(
            "UPDATE curiosity_items SET last_attempt_at = ?1 WHERE id = ?2",
            rusqlite::params![now - 31 * 60_000, id],
        )
        .unwrap();
    db.prune_curiosity(now).unwrap();
    let row = db.curiosity_list(None, Some(10)).unwrap().remove(0);
    assert_eq!(row.status, "open", "崩溃残留的 claimed 自动回收");
    assert_eq!(row.attempts, 1);
}

#[test]
fn prune_expires_stale_open_and_deletes_old_finished() {
    let db = mem_db();
    let id = db
        .curiosity_upsert("旧词", None, "entity", "entity", 1.0, None, None)
        .unwrap();
    let now = now_ms();
    db.conn
        .execute(
            "UPDATE curiosity_items SET created_at = ?1 WHERE id = ?2",
            rusqlite::params![now - 31 * DAY_MS, id],
        )
        .unwrap();
    db.prune_curiosity(now).unwrap();
    let row = db.curiosity_list(None, Some(10)).unwrap().remove(0);
    assert_eq!(row.status, "expired");

    db.conn
        .execute(
            "UPDATE curiosity_items SET updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now - 91 * DAY_MS, id],
        )
        .unwrap();
    db.prune_curiosity(now).unwrap();
    assert!(db.curiosity_list(None, Some(10)).unwrap().is_empty());
}
