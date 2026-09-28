//! 迁移规则（T01–T21）与相位进入辅助。

use super::states::{
    AmbientLeaf, Attending, Companion, ConversationLeaf, Live, OnState, Solitary,
};
use super::PresenceFsm;
use crate::types::{Event, Regime};

impl PresenceFsm {
    pub(crate) fn transition(&mut self, ev: Event, now: u64) {
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

        // —— 工作电平（busy = working）：Thinking 是「回合工作中」的投影 ——
        match ev {
            // T07（泛化）：工作开始即思考，任何活动态直进。
            // 边沿语义（仅 Listening 可进）会被到达顺序吃掉——busy(true) 恒先于
            // user/message 到壳，注入/群/peer 唤醒的整轮工作就整轮丢了 thinking。
            Event::Busy(true) => {
                self.enter_conversation(ConversationLeaf::Thinking);
                return;
            }
            // T08：工作结束才收回合；其他态只清电平（记账在 handle）。
            Event::Busy(false) => {
                if matches!(
                    self.state,
                    Companion::On(OnState::Live(Live::Attending(Attending::Conversation(
                        ConversationLeaf::Thinking
                    ))))
                ) {
                    self.end_conversation_turn(now);
                }
                return;
            }
            // 工作中播报不迁相位：DELIVERING_* 是表现层事实（TTS 嘴型/气泡走 TTS
            // 通道，不看相位），Thinking 保持恒定——工作串判定不得来回跳。
            Event::DeliveringStart | Event::DeliveringEnd if self.ctx.working => {
                return;
            }
            // 工作中的插话（steer）/活动不掉出工作相位；也兜住残余的到达顺序偏差。
            Event::UserChat | Event::ChatActivity if self.ctx.working => {
                self.enter_conversation(ConversationLeaf::Thinking);
                return;
            }
            _ => {}
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
                // T09 取消：工作中 DELIVERING_START 已在工作电平块吞掉，
                // Thinking 恒定不迁 Delivering（原「Thinking→Delivering」会来回跳）。
                (ConversationLeaf::Listening, Event::DeliveringStart) => {
                    self.enter_conversation(ConversationLeaf::Delivering); // T09b
                    return;
                }
                (ConversationLeaf::Delivering, Event::DeliveringEnd) => {
                    // T10 / T11（此处 working 恒为 false——工作中的播报事件
                    // 已被电平块吞掉；Delivering 只由 T09b/T09c 非工作场景进入）
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

        // T09c：输出打断（异步 TTS 晚于回合结束已回 Ambient / Resting 态手动朗读）
        if matches!(ev, Event::DeliveringStart)
            && matches!(live_copy, Live::Resting | Live::Attending(Attending::Ambient(_)))
        {
            self.enter_conversation(ConversationLeaf::Delivering);
            return;
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

    pub(crate) fn remember_ambient(&mut self, leaf: AmbientLeaf) {
        self.history_ambient = leaf;
    }

    pub(crate) fn enter_ambient(&mut self, leaf: AmbientLeaf, now: u64) {
        let _ = now;
        self.remember_ambient(leaf);
        self.state = Companion::On(OnState::Live(Live::Attending(Attending::Ambient(leaf))));
        // 不在此重置 last_activity_at：静默锚点由事件改写；
        // 否则 Booting→Observing 会把 STILL 窗口推后，同一 evaluate 无法到 receptive。
    }

    pub(crate) fn enter_conversation(&mut self, leaf: ConversationLeaf) {
        self.state = Companion::On(OnState::Live(Live::Attending(Attending::Conversation(
            leaf,
        ))));
    }

    /// T08 / T11：回合结束。regime rest 则落 Resting，否则 Ambient 深历史。
    pub(crate) fn end_conversation_turn(&mut self, now: u64) {
        if self.ctx.regime.is_rest() {
            self.enter_resting();
        } else {
            self.enter_ambient(self.history_ambient, now);
        }
        self.ctx.last_activity_at = now;
    }

    pub(crate) fn enter_resting(&mut self) {
        self.state = Companion::On(OnState::Live(Live::Resting));
    }

    pub(crate) fn enter_solitary(&mut self, sol: Solitary) {
        self.state = Companion::On(OnState::Live(Live::Solitary(sol)));
    }
}
