//! L1 能力矩阵（设计 §4 首版）。
//!
//! 表驱动；新能力只加列 + 表行。`●` 允许，`○` 默认否（策略可例外），`—` 无意义（返回 false）。
//! `proactive_inject` 默认仅 `receptive`；策略可对 `observing` 破例（首版不破例）。

use super::types::{Capability, Phase};

pub fn can(phase: Phase, cap: Capability) -> bool {
    use Capability::*;
    use Phase::*;
    match phase {
        Off | Booting => false,
        Passive => matches!(
            cap,
            AcceptUserInput | AutoTts | IdleMotion | MemoryDream | WebExplore
        ),
        Observing => matches!(
            cap,
            AcceptUserInput | AutoTts | IdleMotion | MemoryDream | WebExplore | ReactToPet
        ),
        Receptive => matches!(
            cap,
            AcceptUserInput
                | ProactiveInject
                | AutoTts
                | IdleMotion
                | MemoryDream
                | WebExplore
                | ReactToPet
        ),
        Listening => matches!(
            cap,
            AcceptUserInput | AcceptSteer | AutoTts | IdleMotion | ReactToPet
        ),
        Thinking => matches!(cap, AcceptUserInput | AcceptSteer),
        Delivering => matches!(cap, AcceptUserInput | AcceptSteer | ReactToPet),
        Dreaming => matches!(cap, AcceptUserInput | AcceptSteer),
        Exploring => matches!(cap, AcceptUserInput | AcceptSteer | WebExplore),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matrix_proactive_inject_only_receptive() {
        assert!(can(Phase::Receptive, Capability::ProactiveInject));
        assert!(!can(Phase::Observing, Capability::ProactiveInject));
        assert!(!can(Phase::Thinking, Capability::ProactiveInject));
        assert!(!can(Phase::Passive, Capability::ProactiveInject));
        assert!(!can(Phase::Listening, Capability::ProactiveInject));
    }

    #[test]
    fn matrix_accept_user_input() {
        for p in [
            Phase::Passive,
            Phase::Observing,
            Phase::Receptive,
            Phase::Listening,
            Phase::Thinking,
            Phase::Delivering,
            Phase::Dreaming,
            Phase::Exploring,
        ] {
            assert!(can(p, Capability::AcceptUserInput), "{p:?}");
        }
        assert!(!can(Phase::Off, Capability::AcceptUserInput));
        assert!(!can(Phase::Booting, Capability::AcceptUserInput));
    }

    #[test]
    fn matrix_dream_explore() {
        assert!(can(Phase::Receptive, Capability::MemoryDream));
        assert!(can(Phase::Observing, Capability::MemoryDream));
        assert!(can(Phase::Passive, Capability::MemoryDream));
        assert!(!can(Phase::Listening, Capability::MemoryDream));
        assert!(!can(Phase::Dreaming, Capability::MemoryDream));

        assert!(can(Phase::Exploring, Capability::WebExplore));
        assert!(can(Phase::Receptive, Capability::WebExplore));
        assert!(!can(Phase::Dreaming, Capability::WebExplore));
    }

    #[test]
    fn matrix_auto_tts() {
        assert!(can(Phase::Listening, Capability::AutoTts));
        assert!(!can(Phase::Delivering, Capability::AutoTts));
        assert!(!can(Phase::Thinking, Capability::AutoTts));
    }
}
