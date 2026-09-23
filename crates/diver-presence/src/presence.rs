//! CompanionPresence 裁决门面（设计 §8）。
//!
//! `request` 同步裁决 + 记账；L3 网络调用由壳在返回后 await，失败不双 claim。

use serde::Serialize;

use super::capability;
use super::explore::ExplorePolicy;
use super::fsm::PresenceFsm;
use super::proactive::{ProactiveSnapshot, ProactiveSpeak};
use super::types::{
    Capability, Event, ExploreConfig, ExploreRequest, Intent, Phase, ProactiveConfig, RequestResult,
    TimeThresholds, WebExploreReason,
};

// re-export for shell drivers
pub use super::types::ExploreRequest as ExploreJob;

/// L3 待执行注入（裁决通过后交给壳发送 `POST /api/inject`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InjectRequest {
    pub source: String,
    pub text: String,
    /// UI 折叠线索：`pet-interaction` / `proactive` / `presence` …
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PresenceSnapshot {
    pub phase: Phase,
    pub phase_name: &'static str,
    pub enabled: bool,
    pub regime: &'static str,
    pub user_input_active: bool,
    pub booted_at: u64,
    pub proactive: ProactiveSnapshot,
}

/// L3 待执行探索（裁决通过后交给壳发送 `POST /api/memory/explore`）。
pub use super::types::ExploreRequest as ExploreJobRequest;

/// 进程级存在感总控（壳内单例；本类型本身无全局状态，便于单测）。
#[derive(Debug, Clone)]
pub struct CompanionPresence {
    fsm: PresenceFsm,
    proactive: ProactiveSpeak,
    explore: ExplorePolicy,
}

impl CompanionPresence {
    pub fn boot(now: u64) -> Self {
        Self::boot_with(now, TimeThresholds::default(), ProactiveConfig::default())
    }

    pub fn boot_with(
        now: u64,
        thresholds: TimeThresholds,
        cfg: ProactiveConfig,
    ) -> Self {
        Self::boot_with_full(now, thresholds, cfg, ExploreConfig::default())
    }

    pub fn boot_with_full(
        now: u64,
        thresholds: TimeThresholds,
        cfg: ProactiveConfig,
        explore_cfg: ExploreConfig,
    ) -> Self {
        Self {
            fsm: PresenceFsm::boot_with(now, thresholds),
            // 修 BOOT lastChatAt=now
            proactive: ProactiveSpeak::new(cfg, now),
            explore: ExplorePolicy::new(explore_cfg),
        }
    }

    pub fn handle(&mut self, ev: Event, now: u64) {
        // L2 订阅同一事件总线（不反写 L0 相位）
        match &ev {
            Event::UserChat => {
                self.proactive.note_user_chat(now);
                // T13：打断 dream/explore job（L0 迁 Listening 由 fsm 负责）
                self.explore.release();
            }
            Event::ChatActivity => self.proactive.note_chat(now),
            Event::Boot => {
                self.proactive.note_chat(now);
            }
            Event::ExploreEnd | Event::DreamEnd | Event::Shutdown | Event::Enabled(false) => {
                self.explore.release();
            }
            _ => {}
        }
        self.fsm.handle(ev, now);
    }

    pub fn evaluate(&mut self, now: u64) {
        self.fsm.evaluate(now);
    }

    pub fn set_proactive_config(&mut self, cfg: ProactiveConfig) {
        self.proactive.set_config(cfg);
    }

    pub fn set_explore_config(&mut self, cfg: ExploreConfig) {
        self.explore.set_config(cfg);
    }

    pub fn explore_policy(&mut self) -> &mut ExplorePolicy {
        &mut self.explore
    }

    /// Explore 是否到点该醒（长闲；sleep 更积极）。
    pub fn explore_should_wake(&mut self, now: u64) -> bool {
        self.evaluate(now);
        let phase = self.fsm.phase();
        if !capability::can(phase, Capability::WebExplore) {
            return false;
        }
        if !matches!(
            phase,
            Phase::Passive | Phase::Observing | Phase::Receptive
        ) {
            return false;
        }
        let idle_ms = now.saturating_sub(self.fsm.context().last_activity_at);
        let sleep = self.fsm.context().regime == crate::types::Regime::Sleep;
        self.explore.should_wake(now, idle_ms, sleep)
    }

    pub fn phase(&mut self, now: u64) -> Phase {
        self.evaluate(now);
        self.fsm.phase()
    }

    pub fn phase_raw(&self) -> Phase {
        self.fsm.phase()
    }

    pub fn can(&mut self, cap: Capability, now: u64) -> bool {
        capability::can(self.phase(now), cap)
    }

    pub fn snapshot(&mut self, now: u64) -> PresenceSnapshot {
        self.evaluate(now);
        let phase = self.fsm.phase();
        let ctx = self.fsm.context();
        PresenceSnapshot {
            phase,
            phase_name: phase.as_str(),
            enabled: ctx.enabled,
            regime: ctx.regime.as_str(),
            user_input_active: ctx.user_input_active,
            booted_at: ctx.booted_at,
            proactive: self.proactive.snapshot(),
        }
    }

    /// L1 + 全部 L2；成功则策略记账并交出 L3 注入载荷。
    pub fn request(&mut self, intent: Intent, now: u64) -> (RequestResult, Option<InjectRequest>) {
        self.evaluate(now);
        match intent {
            Intent::ProactiveInject { source, text } => {
                let phase = self.fsm.phase();
                if !capability::can(phase, Capability::ProactiveInject) {
                    return (
                        RequestResult::reject(
                            "L1",
                            None,
                            format!("phase {} denies proactive_inject", phase.as_str()),
                        ),
                        None,
                    );
                }
                if let Some(reason) = self.proactive.veto(now) {
                    return (
                        RequestResult::reject("L2", Some("ProactiveSpeak"), reason.as_str()),
                        None,
                    );
                }
                if let Err(reason) = self.proactive.claim(now) {
                    return (
                        RequestResult::reject("L2", Some("ProactiveSpeak"), reason.as_str()),
                        None,
                    );
                }
                let detail = if source == "pet-interaction" {
                    "pet-interaction".to_string()
                } else if source == "presence" {
                    "presence".to_string()
                } else {
                    "proactive".to_string()
                };
                (
                    RequestResult::ok(),
                    Some(InjectRequest {
                        source,
                        text,
                        detail,
                    }),
                )
            }
            Intent::WebExplore {
                term,
                reason,
                from_memory_id,
            } => {
                // 统一走 request_web_explore（注入载荷不适用，返回 None）。
                let (result, _job) =
                    self.request_web_explore(&term, reason, from_memory_id, now);
                (result, None)
            }
            Intent::MemoryDream { reason, hint } => {
                let phase = self.fsm.phase();
                if !capability::can(phase, Capability::MemoryDream) {
                    return (
                        RequestResult::reject(
                            "L1",
                            None,
                            format!("phase {} denies memory_dream", phase.as_str()),
                        ),
                        None,
                    );
                }
                // Dream 执行面未接；先放行裁决但无 L3 注入载荷（壳侧可记日志）。
                let _ = (reason, hint);
                (RequestResult::ok(), None)
            }
        }
    }

    /// WebExplore 专用：裁决 + 记账，交出 L3 探索载荷。
    pub fn request_web_explore(
        &mut self,
        term: &str,
        reason: WebExploreReason,
        from_memory_id: Option<String>,
        now: u64,
    ) -> (RequestResult, Option<ExploreRequest>) {
        self.evaluate(now);
        let phase = self.fsm.phase();
        if !capability::can(phase, Capability::WebExplore) {
            return (
                RequestResult::reject(
                    "L1",
                    None,
                    format!("phase {} denies web_explore", phase.as_str()),
                ),
                None,
            );
        }
        if let Some(r) = self.explore.veto(term, now) {
            return (
                RequestResult::reject("L2", Some("ExplorePolicy"), r.as_str()),
                None,
            );
        }
        if let Err(r) = self.explore.claim(term, now) {
            return (
                RequestResult::reject("L2", Some("ExplorePolicy"), r.as_str()),
                None,
            );
        }
        (
            RequestResult::ok(),
            Some(ExploreRequest {
                term: term.trim().to_string(),
                reason,
                from_memory_id,
                hint: None,
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Regime;

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
}
