//! 桌宠互动：手势语义事件 → 壳组文案 → CompanionPresence 裁决 → inject。
//!
//! 控制面在壳（见 docs/companion-presence-fsm.md / pet-interaction-events.md）。
//! sidecar 只执行 `POST /api/inject`，不再做闲时门控。
//!
//! 依赖注入：`cos_home` 由 app/command 层传入，本模块不摸 app/shell 单例。

mod apply;
mod config;
mod prompt;
mod types;

pub use apply::{apply_config, submit_pet_gesture};
pub use config::{load_config, save_config};
pub use prompt::build_interaction_prompt;
pub use types::{InteractionMode, PetGestureEvent, PetInteractionConfig};
