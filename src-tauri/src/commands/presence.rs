//! 陪伴存在感 / 桌宠互动语义 command。
//!
//! 只做适配：从 `AppHandle` 取 `cos_home`，再调 core 逻辑。

use tauri::AppHandle;

use crate::config::cos_home;
use crate::core::presence::parse_event::parse_presence_event;
use crate::core::pet_interaction::{PetGestureEvent, PetInteractionConfig};
use crate::core::sidecar::SidecarManager;

/// 存在感相位（叶子名）。调用点会按 now 补发时间事件。
#[tauri::command]
pub fn presence_phase() -> String {
    crate::core::presence::PresenceHandle::global()
        .phase()
        .as_str()
        .to_string()
}

/// 存在感调试快照（相位 + ProactiveSpeak 私有记账）。
#[tauri::command]
pub fn presence_snapshot() -> serde_json::Value {
    serde_json::to_value(crate::core::presence::PresenceHandle::global().snapshot())
        .unwrap_or(serde_json::Value::Null)
}

/// 驱动 L0 事件（手势 / 设置 / 回压统一入口）。
#[tauri::command]
pub fn presence_event(event: String, regime: Option<String>, enabled: Option<bool>) -> String {
    match parse_presence_event(&event, regime.as_deref(), enabled) {
        Ok(ev) => {
            crate::core::presence::PresenceHandle::global().apply_event(ev);
            crate::core::presence::PresenceHandle::global()
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
    crate::core::presence::request_and_inject(&base, &source, &text).await
}

/// Explore 调试快照（L2 私有记账）。
#[tauri::command]
pub fn presence_explore_snapshot() -> serde_json::Value {
    crate::core::explore_policy::snapshot_json()
}

/// 手动触发一次探索（仍走 L1+L2 裁决）。
#[tauri::command]
pub async fn presence_explore_trigger(
    term: String,
    reason: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::core::explore_policy::trigger_manual(&term, reason.as_deref().unwrap_or("manual")).await
}

/// 取消当前探索 job。
#[tauri::command]
pub fn presence_explore_cancel() -> serde_json::Value {
    crate::core::explore_policy::cancel_active_job();
    serde_json::json!({ "ok": true })
}

/// 读取桌宠互动感知设置（壳为真源；与 diver-settings.petInteraction 同步）。
#[tauri::command]
pub fn get_pet_interaction_config(app: AppHandle) -> PetInteractionConfig {
    crate::core::pet_interaction::load_config(&cos_home(&app))
}

/// 保存桌宠互动设置并同步 ProactiveSpeak 节流参数。
#[tauri::command]
pub fn set_pet_interaction_config(
    app: AppHandle,
    config: PetInteractionConfig,
) -> Result<PetInteractionConfig, String> {
    crate::core::pet_interaction::save_config(&cos_home(&app), &config).map_err(|e| e.to_string())?;
    crate::core::pet_interaction::apply_config(&config);
    Ok(config)
}

/// 桌宠手势语义事件：壳组文案 + Presence 裁决 + inject（唯一主动开口入口）。
#[tauri::command]
pub async fn pet_gesture_event(
    app: AppHandle,
    event: PetGestureEvent,
) -> Result<serde_json::Value, String> {
    Ok(crate::core::pet_interaction::submit_pet_gesture(&cos_home(&app), event).await)
}
