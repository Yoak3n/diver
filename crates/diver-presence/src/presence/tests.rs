//! CompanionPresence 门面单测。

use super::*;
use crate::types::{
    Event, ExploreConfig, Intent, Phase, ProactiveConfig, Regime, RequestResult, TimeThresholds,
    WebExploreReason,
};

fn p(now: u64) -> CompanionPresence {
    CompanionPresence::boot_with(
        now,
        TimeThresholds {
            boot_quiet_ms: 1_000,
            still_ms: 2_000,
        },
        ProactiveConfig {
            quiet_ms: 1_000,
            cooldown_ms: 5_000,
            max_triggers: 1,
        },
    )
}

#[test]
fn request_rejected_when_not_receptive() {
    let mut c = p(0);
    // Booting
    let (r, inj) = c.request(
        Intent::ProactiveInject {
            source: "pet-interaction".into(),
            text: "hi".into(),
        },
        100,
    );
    assert!(!r.is_ok());
    assert!(inj.is_none());
}

#[test]
fn request_ok_at_receptive_then_cooling() {
    let mut c = p(0);
    // → Observing @1000, → Receptive @3000（still 从 boot 锚点起算）
    let (r, inj) = c.request(
        Intent::ProactiveInject {
            source: "pet-interaction".into(),
            text: "hi".into(),
        },
        3_100,
    );
    assert!(r.is_ok(), "{r:?}");
    let inj = inj.expect("inject payload");
    assert_eq!(inj.detail, "pet-interaction");

    let (r2, _) = c.request(
        Intent::ProactiveInject {
            source: "pet-interaction".into(),
            text: "again".into(),
        },
        3_500,
    );
    assert!(!r2.is_ok());
}

#[test]
fn l1_rejects_before_l2() {
    let mut c = p(0);
    c.handle(Event::UserChat, 3_100); // Listening：L1 拒
    let (r, _) = c.request(
        Intent::ProactiveInject {
            source: "presence".into(),
            text: "x".into(),
        },
        3_200,
    );
    match r {
        RequestResult::Reject { layer, .. } => assert_eq!(layer, "L1"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn user_chat_resets_proactive_quota() {
    let mut c = p(0);
    let (r, _) = c.request(
        Intent::ProactiveInject {
            source: "pet-interaction".into(),
            text: "a".into(),
        },
        3_100,
    );
    assert!(r.is_ok());
    // 真人插话 → 新闲时窗口；回合结束后才回到可搭话相位
    c.handle(Event::UserChat, 4_000);
    c.handle(Event::Busy(true), 4_100);
    c.handle(Event::Busy(false), 4_200); // → Observing，last_activity=4200
    // still 2000 + quiet 1000 + cooldown 5000（自 3100）
    let (r2, _) = c.request(
        Intent::ProactiveInject {
            source: "pet-interaction".into(),
            text: "b".into(),
        },
        8_200,
    );
    assert!(r2.is_ok(), "{r2:?}");
}

#[test]
fn regime_rest_blocks_proactive() {
    let mut c = p(0);
    c.evaluate(3_000);
    c.handle(Event::Regime(Regime::Dnd), 3_100);
    let (r, _) = c.request(
        Intent::ProactiveInject {
            source: "presence".into(),
            text: "x".into(),
        },
        3_200,
    );
    assert!(!r.is_ok());
}

#[test]
fn snapshot_shape() {
    let mut c = p(1_000);
    let s = c.snapshot(4_000);
    assert_eq!(s.phase_name, "receptive");
    assert_eq!(s.booted_at, 1_000);
    assert_eq!(s.proactive.last_chat_at, 1_000, "BOOT lastChatAt=now");
}

#[test]
fn web_explore_claim_and_user_chat_releases() {
    let mut c = CompanionPresence::boot_with_full(
        0,
        TimeThresholds {
            boot_quiet_ms: 1_000,
            still_ms: 2_000,
        },
        ProactiveConfig::default(),
        ExploreConfig {
            idle_ms: 1_000,
            cooldown_ms: 5_000,
            term_cooldown_ms: 60_000,
            max_per_day: 3,
        },
    );
    c.evaluate(3_100);
    let (r, job) = c.request_web_explore("MXene", WebExploreReason::LongIdle, None, 3_100);
    assert!(r.is_ok(), "{r:?}");
    let job = job.expect("explore job");
    assert_eq!(job.term, "MXene");
    assert!(c.explore_policy().is_active());

    // 二次同刻 claim → already_active
    let (r2, _) = c.request_web_explore("graphene", WebExploreReason::LongIdle, None, 3_200);
    assert!(!r2.is_ok());

    // T13 USER_CHAT 打断
    c.handle(Event::UserChat, 3_300);
    assert!(!c.explore_policy().is_active());
    assert_eq!(c.phase_raw(), Phase::Listening);
}
