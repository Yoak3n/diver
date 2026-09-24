//! 桌宠互动领域类型：模式、配置、手势事件。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use diver_presence::ProactiveConfig;

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

/// 手势白名单（submit 入口校验）。
pub(super) const PET_EVENT_TYPES: &[&str] = &[
    "pet.drag.screen_changed",
    "pet.drag.long_hold",
    "pet.drag.dropped_edge",
    "pet.tap.burst",
];
