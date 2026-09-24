//! PresenceSnapshot 组装。

use serde::Serialize;

use super::super::proactive::ProactiveSnapshot;
use super::super::types::Phase;
use super::CompanionPresence;

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

impl CompanionPresence {
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
}
