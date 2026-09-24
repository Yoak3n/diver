//! 手势入口：白名单 → Presence → 组文案 → inject。

use std::path::Path;

use serde_json::{json, Value};

use crate::core::presence::{request_and_inject, PresenceHandle};
use diver_presence::Event;

use super::config::load_config;
use super::prompt::build_interaction_prompt;
use super::types::{InteractionMode, PetGestureEvent, PetInteractionConfig, PET_EVENT_TYPES};

/// 同步配置到 ProactiveSpeak（设置保存 / 启动加载后调用）。
pub fn apply_config(cfg: &PetInteractionConfig) {
    PresenceHandle::global().set_proactive_config(cfg.to_proactive());
}

/// 手势事件入口：白名单 → L0 PET_GESTURE → 组文案 → request(proactive_inject) → L3。
pub async fn submit_pet_gesture(cos_home: &Path, ev: PetGestureEvent) -> Value {
    if !PET_EVENT_TYPES.contains(&ev.kind.as_str()) {
        return json!({ "accepted": false, "reason": "bad_type" });
    }
    let cfg = load_config(cos_home);
    apply_config(&cfg);
    if cfg.mode == InteractionMode::Off {
        return json!({ "accepted": false, "reason": "disabled" });
    }

    // T17：内部事件，不迁叶；L2 可据此反应（切片 0 只记账）
    PresenceHandle::global().apply_event(Event::PetGesture);

    let text = build_interaction_prompt(&ev, cfg.mode);
    let base = crate::core::sidecar::SidecarManager::global().api_base_url();
    match request_and_inject(&base, "pet-interaction", &text).await {
        Ok(body) => {
            let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            if ok {
                json!({
                    "accepted": true,
                    "triggered": true,
                    "messageId": body.get("dispatch").and_then(|d| d.get("messageId")).cloned().unwrap_or(Value::Null),
                })
            } else {
                let reason = body
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("rejected")
                    .to_string();
                json!({ "accepted": false, "reason": reason })
            }
        }
        Err(e) => json!({ "accepted": false, "reason": "dispatch_failed", "detail": e }),
    }
}
