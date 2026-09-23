//! 陪伴存在感 / 桌宠互动语义 command。

use diver_presence::{Event, Regime};

use crate::base::sidecar::SidecarManager;

/// 解析前端事件名 → `diver_presence::Event`。纯函数，便于单测。
fn parse_presence_event(
    event: &str,
    regime: Option<&str>,
    enabled: Option<bool>,
) -> Result<Event, String> {
    let ev = match event {
        "USER_CHAT" => Event::UserChat,
        "CHAT_ACTIVITY" => Event::ChatActivity,
        "USER_INPUT_START" => Event::UserInputStart,
        "USER_INPUT_END" => Event::UserInputEnd,
        "PET_GESTURE" => Event::PetGesture,
        "DELIVERING_START" => Event::DeliveringStart,
        "DELIVERING_END" => Event::DeliveringEnd,
        "DREAM_START" => Event::DreamStart,
        "DREAM_END" => Event::DreamEnd,
        "EXPLORE_START" => Event::ExploreStart,
        "EXPLORE_END" => Event::ExploreEnd,
        "BOOT" => Event::Boot,
        "SHUTDOWN" => Event::Shutdown,
        "BUSY_TRUE" => Event::Busy(true),
        "BUSY_FALSE" => Event::Busy(false),
        "REGIME" => {
            let r = match regime {
                Some("dnd") => Regime::Dnd,
                Some("quiet_hours") => Regime::QuietHours,
                Some("focus") => Regime::Focus,
                Some("sleep") => Regime::Sleep,
                _ => Regime::Normal,
            };
            Event::Regime(r)
        }
        "ENABLED" => Event::Enabled(enabled.unwrap_or(true)),
        other => return Err(format!("unknown:{other}")),
    };
    Ok(ev)
}

/// 存在感相位（叶子名）。调用点会按 now 补发时间事件。
#[tauri::command]
pub fn presence_phase() -> String {
    crate::base::presence::PresenceHandle::global()
        .phase()
        .as_str()
        .to_string()
}

/// 存在感调试快照（相位 + ProactiveSpeak 私有记账）。
#[tauri::command]
pub fn presence_snapshot() -> serde_json::Value {
    serde_json::to_value(crate::base::presence::PresenceHandle::global().snapshot())
        .unwrap_or(serde_json::Value::Null)
}

/// 驱动 L0 事件（手势 / 设置 / 回压统一入口）。
#[tauri::command]
pub fn presence_event(event: String, regime: Option<String>, enabled: Option<bool>) -> String {
    match parse_presence_event(&event, regime.as_deref(), enabled) {
        Ok(ev) => {
            crate::base::presence::PresenceHandle::global().handle_event(ev);
            crate::base::presence::PresenceHandle::global()
                .phase()
                .as_str()
                .to_string()
        }
        Err(msg) => msg,
    }
}

/// 裁决并下发主动注入（sidecar `POST /api/inject`，无门控执行）。
#[tauri::command]
pub async fn presence_request_inject(
    source: String,
    text: String,
) -> Result<serde_json::Value, String> {
    let base = SidecarManager::global().api_base_url();
    crate::base::presence::request_and_inject(&base, &source, &text).await
}

/// Explore 调试快照（L2 私有记账）。
#[tauri::command]
pub fn presence_explore_snapshot() -> serde_json::Value {
    crate::base::explore_policy::snapshot_json()
}

/// 手动触发一次探索（仍走 L1+L2 裁决）。
#[tauri::command]
pub async fn presence_explore_trigger(
    term: String,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::base::explore_policy::trigger_manual(&term, reason.as_deref().unwrap_or("manual")).await
}

/// 取消当前探索 job。
#[tauri::command]
pub fn presence_explore_cancel() -> serde_json::Value {
    crate::base::explore_policy::cancel_active_job();
    serde_json::json!({ "ok": true })
}

/// 读取桌宠互动感知设置（壳为真源；与 diver-settings.petInteraction 同步）。
#[tauri::command]
pub fn get_pet_interaction_config() -> crate::base::pet_interaction::PetInteractionConfig {
    crate::base::pet_interaction::load_config()
}

/// 保存桌宠互动设置并同步 ProactiveSpeak 节流参数。
#[tauri::command]
pub fn set_pet_interaction_config(
    config: crate::base::pet_interaction::PetInteractionConfig,
) -> Result<crate::base::pet_interaction::PetInteractionConfig, String> {
    crate::base::pet_interaction::save_config(&config).map_err(|e| e.to_string())?;
    crate::base::pet_interaction::apply_config(&config);
    Ok(config)
}

/// 桌宠手势语义事件：壳组文案 + Presence 裁决 + inject（唯一主动开口入口）。
#[tauri::command]
pub async fn pet_gesture_event(
    event: crate::base::pet_interaction::PetGestureEvent,
) -> Result<serde_json::Value, String> {
    Ok(crate::base::pet_interaction::handle_pet_gesture(event).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_events() {
        assert!(matches!(
            parse_presence_event("USER_CHAT", None, None),
            Ok(Event::UserChat)
        ));
        assert!(matches!(
            parse_presence_event("BUSY_TRUE", None, None),
            Ok(Event::Busy(true))
        ));
        assert!(matches!(
            parse_presence_event("ENABLED", None, Some(false)),
            Ok(Event::Enabled(false))
        ));
    }

    #[test]
    fn parses_regime_with_default() {
        assert!(matches!(
            parse_presence_event("REGIME", Some("dnd"), None),
            Ok(Event::Regime(Regime::Dnd))
        ));
        assert!(matches!(
            parse_presence_event("REGIME", None, None),
            Ok(Event::Regime(Regime::Normal))
        ));
    }

    #[test]
    fn rejects_unknown_event() {
        assert_eq!(
            parse_presence_event("NOPE", None, None),
            Err("unknown:NOPE".to_string())
        );
    }
}
