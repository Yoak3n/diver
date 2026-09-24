//! 桌宠互动：手势语义事件 → 壳组文案 → CompanionPresence 裁决 → inject。
//!
//! 控制面在壳（见 docs/companion-presence-fsm.md / pet-interaction-events.md）。
//! sidecar 只执行 `POST /api/inject`，不再做闲时门控。
//!
//! 依赖注入：`cos_home` 由 app/command 层传入，本模块不摸 app/shell 单例。

mod config;
mod prompt;

pub use config::{load_config, save_config};
pub use prompt::build_interaction_prompt;

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::core::presence::{request_and_inject, PresenceHandle};
use diver_presence::{Event, ProactiveConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionMode {
    Off,
    Events,
    Context,
}

impl Default for InteractionMode {
    fn default() -> Self {
        InteractionMode::Events
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetInteractionConfig {
    pub mode: InteractionMode,
    pub quiet_ms: u64,
    pub cooldown_ms: u64,
    pub max_triggers: u32,
    pub long_hold_ms: u64,
}

impl Default for PetInteractionConfig {
    fn default() -> Self {
        Self {
            mode: InteractionMode::Events,
            quiet_ms: 10_000,
            cooldown_ms: 45_000,
            max_triggers: 1,
            long_hold_ms: 3_000,
        }
    }
}

impl PetInteractionConfig {
    pub fn to_proactive(&self) -> ProactiveConfig {
        ProactiveConfig {
            quiet_ms: self.quiet_ms,
            cooldown_ms: self.cooldown_ms,
            max_triggers: self.max_triggers,
        }
    }
}

/// 手势事件（PetApp 经 invoke 上报）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetGestureEvent {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub ts: Option<u64>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub payload: Map<String, Value>,
    #[serde(default)]
    pub context: Option<Value>,
}

const PET_EVENT_TYPES: &[&str] = &[
    "pet.drag.screen_changed",
    "pet.drag.long_hold",
    "pet.drag.dropped_edge",
    "pet.tap.burst",
];

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
