//! PresenceFsm 单测（迁移 T01–T21 与深历史）。

use super::*;
use crate::types::{Event, Phase, Regime, TimeThresholds};

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
fn t09_cancelled_delivering_ignored_while_working() {
    let mut f = fsm_at(0);
    f.handle(Event::UserChat, 3_100);
    f.handle(Event::Busy(true), 3_200);
    // T09 取消：工作中的播报是表现层事实，相位不迁 Delivering、不来回跳
    f.handle(Event::DeliveringStart, 3_300);
    assert_eq!(f.phase(), Phase::Thinking);
    f.handle(Event::DeliveringEnd, 3_800);
    assert_eq!(f.phase(), Phase::Thinking);
    // 工作真正结束才收回合
    f.handle(Event::Busy(false), 4_000);
    assert_eq!(f.phase(), Phase::Observing);
}

#[test]
fn t10_delivering_end_user_still_typing() {
    let mut f = fsm_at(0);
    f.handle(Event::UserChat, 3_100);
    f.handle(Event::Busy(true), 3_200);
    f.handle(Event::Busy(false), 3_250); // 工作先结束：T10 的「非工作」前提
    f.handle(Event::DeliveringStart, 3_300);
    f.handle(Event::UserInputStart, 3_400);
    f.handle(Event::DeliveringEnd, 3_800);
    assert_eq!(f.phase(), Phase::Listening);
}

#[test]
fn working_span_ignores_delivering_and_input_events() {
    // 工作电平期间：播报事件与用户输入信号都不改变相位（恒定 Thinking）
    let mut f = fsm_at(0);
    f.handle(Event::UserChat, 3_100);
    f.handle(Event::Busy(true), 3_200);
    f.handle(Event::DeliveringStart, 3_300);
    f.handle(Event::UserInputStart, 3_400);
    f.handle(Event::DeliveringEnd, 3_800);
    assert_eq!(f.phase(), Phase::Thinking);
    f.handle(Event::Busy(false), 4_000);
    assert_eq!(f.phase(), Phase::Observing);
}

#[test]
fn busy_true_from_ambient_enters_thinking() {
    // 注入 / proactive / 群 / peer 唤醒的回合：busy(true) 恒先于消息事件到壳，
    // 不得被吃掉——工作开始即思考（原边沿语义下这种回合整轮丢 thinking）。
    let mut f = fsm_at(0);
    f.evaluate(3_000);
    assert_eq!(f.phase(), Phase::Receptive);
    f.handle(Event::Busy(true), 3_100);
    assert_eq!(f.phase(), Phase::Thinking);
}

#[test]
fn working_span_holds_through_tool_chain_events() {
    // 图中长工作串：多步工具调用（思考/编辑/读取）+ 活动事件流 + 中插消息/播报，
    // 工作电平期间相位必须**恒为 Thinking、零跳变**，直到 busy(false)。
    let mut f = fsm_at(0);
    f.handle(Event::UserChat, 3_100);
    f.handle(Event::Busy(true), 3_200);
    let chain: &[(u64, Event)] = &[
        (3_300, Event::ChatActivity),     // 工具步 / 流式活动
        (3_400, Event::DeliveringStart),  // 工作中播报
        (3_500, Event::ChatActivity),
        (3_600, Event::UserChat),         // 工作中 steer 插话
        (3_700, Event::DeliveringEnd),
        (3_800, Event::ChatActivity),
    ];
    for (t, ev) in chain {
        f.handle(ev.clone(), *t);
        assert_eq!(f.phase(), Phase::Thinking, "工作串内相位必须恒定：@{t} {ev:?}");
    }
    f.handle(Event::Busy(false), 3_900);
    assert_eq!(f.phase(), Phase::Observing);
}

#[test]
fn speech_does_not_delay_turn_end() {
    // 工作在播报中结束：立即收回合，不等播完、不回 Thinking
    let mut f = fsm_at(0);
    f.handle(Event::UserChat, 3_100);
    f.handle(Event::Busy(true), 3_200);
    f.handle(Event::DeliveringStart, 3_300); // 吞掉（工作电平）
    assert_eq!(f.phase(), Phase::Thinking);
    f.handle(Event::Busy(false), 3_400);
    assert_eq!(f.phase(), Phase::Observing);
    f.handle(Event::DeliveringEnd, 3_800); // 播报收尾不迁移
    assert_eq!(f.phase(), Phase::Observing);
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

#[test]
fn t09b_delivering_from_listening() {
    let mut f = fsm_at(0);
    f.handle(Event::UserChat, 3_100);
    assert_eq!(f.phase(), Phase::Listening);
    f.handle(Event::DeliveringStart, 3_150);
    assert_eq!(f.phase(), Phase::Delivering);
    f.handle(Event::DeliveringEnd, 3_600);
    assert_eq!(f.phase(), Phase::Observing);
}

#[test]
fn t09c_delivering_from_ambient_after_turn() {
    // 自动朗读晚于回合结束：busy(false) 已回深历史 Ambient，播报才开始
    let mut f = fsm_at(0);
    f.evaluate(3_000);
    f.handle(Event::UserChat, 3_100);
    f.handle(Event::Busy(true), 3_200);
    f.handle(Event::Busy(false), 4_000);
    assert_eq!(f.phase(), Phase::Receptive);
    f.handle(Event::DeliveringStart, 4_300);
    assert_eq!(f.phase(), Phase::Delivering);
    f.handle(Event::DeliveringEnd, 5_000);
    assert_eq!(f.phase(), Phase::Receptive);
}

#[test]
fn t09c_delivering_from_resting_returns_to_rest() {
    let mut f = fsm_at(0);
    f.evaluate(3_000);
    f.handle(Event::Regime(Regime::Dnd), 3_050);
    assert_eq!(f.phase(), Phase::Passive);
    f.handle(Event::DeliveringStart, 3_100);
    assert_eq!(f.phase(), Phase::Delivering);
    f.handle(Event::DeliveringEnd, 3_600);
    assert_eq!(f.phase(), Phase::Passive);
}
