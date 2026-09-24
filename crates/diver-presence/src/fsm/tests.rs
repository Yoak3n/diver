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
