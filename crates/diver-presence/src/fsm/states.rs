//! 状态叶子与上下文类型（L0 HSM 内部状态）。

use super::super::types::{Phase, Regime};

/// Live 深历史（只记 Ambient 子叶；Conversation 不参与恢复）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AmbientLeaf {
    Observing,
    Receptive,
}

impl AmbientLeaf {
    pub(crate) fn phase(self) -> Phase {
        match self {
            AmbientLeaf::Observing => Phase::Observing,
            AmbientLeaf::Receptive => Phase::Receptive,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConversationLeaf {
    Listening,
    Thinking,
    Delivering,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Attending {
    Ambient(AmbientLeaf),
    Conversation(ConversationLeaf),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Solitary {
    Dreaming,
    Exploring,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Live {
    Resting,
    Attending(Attending),
    Solitary(Solitary),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OnState {
    Booting,
    Live(Live),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Companion {
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
    pub(crate) fn new(now: u64) -> Self {
        Self {
            enabled: true,
            booted_at: now,
            regime: Regime::Normal,
            user_input_active: false,
            last_activity_at: now,
        }
    }
}
