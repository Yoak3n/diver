//! 前端事件名 → `diver_presence::Event` 纯解析（command 层只转发）。

use diver_presence::{Event, Regime};

/// 解析前端事件名。未知事件返回 `Err("unknown:…")`，与历史 command 返回值兼容。
pub fn parse_presence_event(
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
