//! L0 Companion Presence HSM —— 纯逻辑，无定时器。
//!
//! 层级：Companion → On → Booting | Live → Resting | Attending | Solitary。
//! 迁移挂超态；冲突内层优先；时间由 `evaluate(now)` 补发 `QuietElapsed` / `StillElapsed`。
//! 深历史：从 Resting/Solitary 回 Live 时进 Ambient 子叶，不回 Conversation。

use super::types::{Event, Phase, Regime, TimeThresholds};

/// Live 深历史（只记 Ambient 子叶；Conversation 不参与恢复）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AmbientLeaf {
    Observing,
    Receptive,
}

impl AmbientLeaf {
    fn phase(self) -> Phase {
        match self {
            AmbientLeaf::Observing => Phase::Observing,
            AmbientLeaf::Receptive => Phase::Receptive,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConversationLeaf {
    Listening,
    Thinking,
    Delivering,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attending {
    Ambient(AmbientLeaf),
    Conversation(ConversationLeaf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Solitary {
    Dreaming,
    Exploring,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Live {
    Resting,
    Attending(Attending),
    Solitary(Solitary),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OnState {
    Booting,
    Live(Live),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Companion {
    Off,
    On(OnState),
}

/// L0 真源上下文（设计 §5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Context {
    pub enabled: bool,
    pub booted_at: u64,
    pub regime: Regime,
    /// 用户输入框焦点/键入中。
    pub user_input_active: bool,
    /// 观察静默锚点（最后扰动）。
    pub last_activity_at: u64,
}

impl Context {
    fn new(now: u64) -> Self {
        Self {
            enabled: true,
            booted_at: now,
            regime: Regime::Normal,
            user_input_active: false,
            last_activity_at: now,
        }
    }
}

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

    fn transition(&mut self, ev: Event, now: u64) {
        // T01 / T19：Companion / On 根级
        match ev {
            Event::Enabled(false) | Event::Shutdown => {
                self.state = Companion::Off;
                return;
            }
            Event::Enabled(true) => {
                if matches!(self.state, Companion::Off) {
                    self.ctx.booted_at = now;
                    self.ctx.last_activity_at = now;
                    self.state = Companion::On(OnState::Booting);
                }
                return;
            }
            _ => {}
        }

        if matches!(self.state, Companion::Off) {
            return;
        }

        // T03：Booting + QUIET_ELAPSED → Observing
        if matches!(self.state, Companion::On(OnState::Booting)) {
            match ev {
                Event::QuietElapsed => {
                    self.enter_ambient(AmbientLeaf::Observing, now);
                }
                // USER_CHAT 最高优先：boot 缓冲内也要进对话
                Event::UserChat => {
                    self.enter_conversation(ConversationLeaf::Listening);
                }
                _ => {}
            }
            return;
        }

        let live_copy = match self.state {
            Companion::On(OnState::Live(l)) => l,
            _ => return,
        };

        // T06 / T13 / T18：USER_CHAT
        if matches!(ev, Event::UserChat) {
            match live_copy {
                Live::Attending(Attending::Conversation(_)) => self
                    .enter_conversation(ConversationLeaf::Listening), // T18
                Live::Solitary(_) => self.enter_conversation(ConversationLeaf::Listening), // T13
                Live::Resting | Live::Attending(Attending::Ambient(_)) => {
                    self.enter_conversation(ConversationLeaf::Listening)
                } // T06
            }
            return;
        }

        // Conversation 内层
        if let Live::Attending(Attending::Conversation(cl)) = live_copy {
            match (cl, &ev) {
                (ConversationLeaf::Listening, Event::Busy(true)) => {
                    self.enter_conversation(ConversationLeaf::Thinking); // T07
                    return;
                }
                (ConversationLeaf::Thinking, Event::Busy(false)) => {
                    self.end_conversation_turn(now); // T08 无待播
                    return;
                }
                (ConversationLeaf::Thinking, Event::DeliveringStart) => {
                    self.enter_conversation(ConversationLeaf::Delivering); // T09
                    return;
                }
                (ConversationLeaf::Delivering, Event::DeliveringEnd) => {
                    // T10 / T11
                    if self.ctx.user_input_active {
                        self.enter_conversation(ConversationLeaf::Listening);
                    } else {
                        self.end_conversation_turn(now);
                    }
                    return;
                }
                _ => {}
            }
        }

        // T04 / T05：Regime ↔ Resting（Conversation 不被掐断）
        if let Event::Regime(r) = ev {
            let in_conversation = matches!(live_copy, Live::Attending(Attending::Conversation(_)));
            if r.is_rest() && !in_conversation {
                self.enter_resting(); // T04
                return;
            }
            if r == Regime::Normal && matches!(live_copy, Live::Resting) {
                self.enter_ambient(self.history_ambient, now); // T05 深历史
                return;
            }
            return;
        }

        // T15 / T16 / T17：Ambient
        if let Live::Attending(Attending::Ambient(amb)) = live_copy {
            match (amb, &ev) {
                (AmbientLeaf::Observing, Event::StillElapsed) => {
                    self.enter_ambient(AmbientLeaf::Receptive, now); // T15
                    return;
                }
                (AmbientLeaf::Receptive, Event::UserInputStart) => {
                    self.enter_ambient(AmbientLeaf::Observing, now); // T16
                    return;
                }
                (_, Event::PetGesture) => return, // T17 内部
                _ => {}
            }
        }

        // T14 / T21：Solitary
        if let Live::Solitary(sol) = live_copy {
            match (sol, &ev) {
                (_, Event::DreamEnd | Event::ExploreEnd) => {
                    self.enter_ambient(self.history_ambient, now); // T14
                    return;
                }
                (Solitary::Dreaming, Event::ExploreStart) => return, // T21 dream 占道
                (_, Event::DreamStart | Event::ExploreStart) => return,
                _ => {}
            }
        }

        // T12 / T20：Ambient|Resting → Solitary
        let can_enter_solitary = matches!(
            live_copy,
            Live::Resting | Live::Attending(Attending::Ambient(_))
        );
        if can_enter_solitary {
            match ev {
                Event::DreamStart => {
                    self.enter_solitary(Solitary::Dreaming);
                    return;
                }
                Event::ExploreStart => {
                    self.enter_solitary(Solitary::Exploring); // 与 Dream 互斥
                    return;
                }
                _ => {}
            }
        }
        let _ = now;
    }

    fn remember_ambient(&mut self, leaf: AmbientLeaf) {
        self.history_ambient = leaf;
    }

    fn enter_ambient(&mut self, leaf: AmbientLeaf, now: u64) {
        let _ = now;
        self.remember_ambient(leaf);
        self.state = Companion::On(OnState::Live(Live::Attending(Attending::Ambient(leaf))));
        // 不在此重置 last_activity_at：静默锚点由事件改写；
        // 否则 Booting→Observing 会把 STILL 窗口推后，同一 evaluate 无法到 receptive。
    }

    fn enter_conversation(&mut self, leaf: ConversationLeaf) {
        self.state = Companion::On(OnState::Live(Live::Attending(Attending::Conversation(
            leaf,
        ))));
    }

    /// T08 / T11：回合结束。regime rest 则落 Resting，否则 Ambient 深历史。
    fn end_conversation_turn(&mut self, now: u64) {
        if self.ctx.regime.is_rest() {
            self.enter_resting();
        } else {
            self.enter_ambient(self.history_ambient, now);
        }
        self.ctx.last_activity_at = now;
    }

    fn enter_resting(&mut self) {
        self.state = Companion::On(OnState::Live(Live::Resting));
    }

    fn enter_solitary(&mut self, sol: Solitary) {
        self.state = Companion::On(OnState::Live(Live::Solitary(sol)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fsm_at(boot: u64) -> PresenceFsm {
        PresenceFsm::boot_with(
            boot,
            TimeThresholds {
                boot_quiet_ms: 1_000,
                still_ms: 2_000,
            },
        )
    }

    #[test]
    fn t03_booting_to_observing() {
        let mut f = fsm_at(0);
        assert_eq!(f.phase(), Phase::Booting);
        f.evaluate(500);
        assert_eq!(f.phase(), Phase::Booting);
        f.evaluate(1_000);
        assert_eq!(f.phase(), Phase::Observing);
    }

    #[test]
    fn t15_observing_to_receptive() {
        let mut f = fsm_at(0);
        f.evaluate(1_000);
        assert_eq!(f.phase(), Phase::Observing);
        f.evaluate(2_500);
        assert_eq!(f.phase(), Phase::Receptive);
    }

    #[test]
    fn t01_disable_to_off() {
        let mut f = fsm_at(0);
        f.evaluate(1_000);
        f.handle(Event::Enabled(false), 1_100);
        assert_eq!(f.phase(), Phase::Off);
        f.handle(Event::Enabled(true), 1_200);
        assert_eq!(f.phase(), Phase::Booting);
    }

    #[test]
    fn t06_user_chat_to_listening() {
        let mut f = fsm_at(0);
        f.evaluate(3_000);
        assert_eq!(f.phase(), Phase::Receptive);
        f.handle(Event::UserChat, 3_100);
        assert_eq!(f.phase(), Phase::Listening);
    }

    #[test]
    fn t07_t08_busy_turn() {
        let mut f = fsm_at(0);
        f.handle(Event::UserChat, 3_100);
        f.handle(Event::Busy(true), 3_200);
        assert_eq!(f.phase(), Phase::Thinking);
        f.handle(Event::Busy(false), 4_000);
        assert_eq!(f.phase(), Phase::Observing);
    }

    #[test]
    fn t09_t11_delivering() {
        let mut f = fsm_at(0);
        f.handle(Event::UserChat, 3_100);
        f.handle(Event::Busy(true), 3_200);
        f.handle(Event::DeliveringStart, 3_300);
        assert_eq!(f.phase(), Phase::Delivering);
        f.handle(Event::DeliveringEnd, 3_800);
        assert_eq!(f.phase(), Phase::Observing);
    }

    #[test]
    fn t10_delivering_end_user_still_typing() {
        let mut f = fsm_at(0);
        f.handle(Event::UserChat, 3_100);
        f.handle(Event::Busy(true), 3_200);
        f.handle(Event::DeliveringStart, 3_300);
        f.handle(Event::UserInputStart, 3_400);
        f.handle(Event::DeliveringEnd, 3_800);
        assert_eq!(f.phase(), Phase::Listening);
    }

    #[test]
    fn t04_t05_regime_resting() {
        let mut f = fsm_at(0);
        f.evaluate(3_000);
        f.handle(Event::Regime(Regime::Dnd), 3_100);
        assert_eq!(f.phase(), Phase::Passive);
        f.handle(Event::Regime(Regime::Normal), 3_200);
        assert_eq!(f.phase(), Phase::Receptive);
    }

    #[test]
    fn regime_does_not_cut_conversation() {
        let mut f = fsm_at(0);
        f.handle(Event::UserChat, 3_100);
        f.handle(Event::Regime(Regime::Sleep), 3_200);
        assert_eq!(f.phase(), Phase::Listening);
        f.handle(Event::Busy(true), 3_300);
        f.handle(Event::Busy(false), 3_400);
        assert_eq!(f.phase(), Phase::Passive);
    }

    #[test]
    fn t12_t13_dream_interrupted_by_user() {
        let mut f = fsm_at(0);
        f.evaluate(3_000);
        f.handle(Event::DreamStart, 3_100);
        assert_eq!(f.phase(), Phase::Dreaming);
        f.handle(Event::UserChat, 3_200);
        assert_eq!(f.phase(), Phase::Listening);
    }

    #[test]
    fn t14_dream_end_deep_history() {
        let mut f = fsm_at(0);
        f.evaluate(3_000);
        f.handle(Event::DreamStart, 3_100);
        f.handle(Event::DreamEnd, 4_000);
        assert_eq!(f.phase(), Phase::Receptive);
    }

    #[test]
    fn t20_t21_solitary_mutex() {
        let mut f = fsm_at(0);
        f.evaluate(3_000);
        f.handle(Event::DreamStart, 3_100);
        assert_eq!(f.phase(), Phase::Dreaming);
        f.handle(Event::ExploreStart, 3_200);
        assert_eq!(f.phase(), Phase::Dreaming); // T21
        f.handle(Event::DreamEnd, 3_300);
        f.handle(Event::ExploreStart, 3_400);
        assert_eq!(f.phase(), Phase::Exploring);
    }

    #[test]
    fn t13_solitary_user_chat() {
        let mut f = fsm_at(0);
        f.evaluate(3_000);
        f.handle(Event::ExploreStart, 3_100);
        assert_eq!(f.phase(), Phase::Exploring);
        f.handle(Event::UserChat, 3_200);
        assert_eq!(f.phase(), Phase::Listening);
    }

    #[test]
    fn t16_receptive_input_back_to_observing() {
        let mut f = fsm_at(0);
        f.evaluate(3_000);
        assert_eq!(f.phase(), Phase::Receptive);
        f.handle(Event::UserInputStart, 3_100);
        assert_eq!(f.phase(), Phase::Observing);
    }

    #[test]
    fn t17_pet_gesture_internal() {
        let mut f = fsm_at(0);
        f.evaluate(3_000);
        let before = f.phase();
        f.handle(Event::PetGesture, 3_100);
        assert_eq!(f.phase(), before);
    }

    #[test]
    fn deep_history_skips_conversation() {
        let mut f = fsm_at(0);
        f.handle(Event::UserChat, 3_100);
        f.handle(Event::Busy(true), 3_200);
        f.handle(Event::Busy(false), 3_300);
        f.handle(Event::Regime(Regime::Focus), 3_400);
        assert_eq!(f.phase(), Phase::Passive);
        f.handle(Event::Regime(Regime::Normal), 3_500);
        assert_eq!(f.phase(), Phase::Observing);
    }
}
