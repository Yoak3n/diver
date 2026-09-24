//! L0 Companion Presence HSM —— 纯逻辑，无定时器。
//!
//! 层级：Companion → On → Booting | Live → Resting | Attending | Solitary。
//! 迁移挂超态；冲突内层优先；时间由 `evaluate(now)` 补发 `QuietElapsed` / `StillElapsed`。
//! 深历史：从 Resting/Solitary 回 Live 时进 Ambient 子叶，不回 Conversation。

mod states;
mod transitions;
#[cfg(test)]
mod tests;

pub use states::Context;

use states::{AmbientLeaf, Attending, Companion, ConversationLeaf, Live, OnState, Solitary};
use crate::types::{Event, Phase, TimeThresholds};

/// L0 HSM。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceFsm {
    state: Companion,
    ctx: Context,
    history_ambient: AmbientLeaf,
    thresholds: TimeThresholds,
}

impl PresenceFsm {
    /// 根初始：On/Booting（`booted_at = now`）。
    pub fn boot(now: u64) -> Self {
        Self::boot_with(now, TimeThresholds::default())
    }

    pub fn boot_with(now: u64, thresholds: TimeThresholds) -> Self {
        Self {
            state: Companion::On(OnState::Booting),
            ctx: Context::new(now),
            history_ambient: AmbientLeaf::Observing,
            thresholds,
        }
    }

    pub fn phase(&self) -> Phase {
        match self.state {
            Companion::Off => Phase::Off,
            Companion::On(OnState::Booting) => Phase::Booting,
            Companion::On(OnState::Live(Live::Resting)) => Phase::Passive,
            Companion::On(OnState::Live(Live::Attending(Attending::Ambient(a)))) => a.phase(),
            Companion::On(OnState::Live(Live::Attending(Attending::Conversation(c)))) => match c {
                ConversationLeaf::Listening => Phase::Listening,
                ConversationLeaf::Thinking => Phase::Thinking,
                ConversationLeaf::Delivering => Phase::Delivering,
            },
            Companion::On(OnState::Live(Live::Solitary(Solitary::Dreaming))) => Phase::Dreaming,
            Companion::On(OnState::Live(Live::Solitary(Solitary::Exploring))) => Phase::Exploring,
        }
    }

    pub fn context(&self) -> &Context {
        &self.ctx
    }

    pub fn thresholds(&self) -> TimeThresholds {
        self.thresholds
    }

    /// 按 `now` 补发时间事件（EVAL）；禁止用定时器迁态。
    pub fn evaluate(&mut self, now: u64) {
        if matches!(self.state, Companion::On(OnState::Booting))
            && now.saturating_sub(self.ctx.booted_at) >= self.thresholds.boot_quiet_ms
        {
            self.handle(Event::QuietElapsed, now);
        }
        if matches!(
            self.state,
            Companion::On(OnState::Live(Live::Attending(Attending::Ambient(
                AmbientLeaf::Observing
            ))))
        ) && now.saturating_sub(self.ctx.last_activity_at) >= self.thresholds.still_ms
        {
            self.handle(Event::StillElapsed, now);
        }
    }

    /// 驱动一次迁移（含上下文改写）。挂载原则：能写在 Live 的不写到叶。
    pub fn handle(&mut self, ev: Event, now: u64) {
        match &ev {
            Event::Boot => {
                self.ctx.enabled = true;
                self.ctx.booted_at = now;
                self.ctx.last_activity_at = now;
            }
            Event::Shutdown => {
                self.ctx.enabled = false;
            }
            Event::Enabled(b) => {
                self.ctx.enabled = *b;
            }
            Event::Regime(r) => {
                self.ctx.regime = *r;
            }
            Event::UserChat | Event::UserInputStart | Event::PetGesture | Event::ChatActivity => {
                self.ctx.last_activity_at = now;
                if matches!(ev, Event::UserInputStart) {
                    self.ctx.user_input_active = true;
                }
            }
            Event::UserInputEnd => {
                self.ctx.user_input_active = false;
            }
            Event::DreamStart | Event::DreamEnd | Event::ExploreStart | Event::ExploreEnd => {
                self.ctx.last_activity_at = now;
            }
            _ => {}
        }
        self.transition(ev, now);
    }
}
