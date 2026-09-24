//! CompanionPresence 裁决门面（设计 §8）。
//!
//! `request` 同步裁决 + 记账；L3 网络调用由壳在返回后 await，失败不双 claim。

mod adjudicate;
mod snapshot;
#[cfg(test)]
mod tests;

pub use snapshot::PresenceSnapshot;

use serde::Serialize;

use super::capability;
use super::explore::ExplorePolicy;
use super::fsm::PresenceFsm;
use super::proactive::ProactiveSpeak;
use super::types::{
    Capability, Event, ExploreConfig, Phase, ProactiveConfig, TimeThresholds,
};

// re-export for shell drivers
pub use super::types::ExploreRequest as ExploreJob;
/// L3 待执行探索（裁决通过后交给壳发送 `POST /api/memory/explore`）。
pub use super::types::ExploreRequest as ExploreJobRequest;

/// L3 待执行注入（裁决通过后交给壳发送 `POST /api/inject`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InjectRequest {
    pub source: String,
    pub text: String,
    /// UI 折叠线索：`pet-interaction` / `proactive` / `presence` …
    pub detail: String,
}

/// 进程级存在感总控（壳内单例；本类型本身无全局状态，便于单测）。
#[derive(Debug, Clone)]
pub struct CompanionPresence {
    pub(crate) fsm: PresenceFsm,
    pub(crate) proactive: ProactiveSpeak,
    pub(crate) explore: ExplorePolicy,
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
}
