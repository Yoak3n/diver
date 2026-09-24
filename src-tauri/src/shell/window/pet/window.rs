//! 桌宠窗口配置读写、缩放与位置持久化。

use tauri::{AppHandle, Emitter, Manager};

use crate::config::pet_window::{self, PetWindowConfig};
use diver_geom::*;

use super::position::ensure_visible;

/// 桌宠窗口 label（与 `WindowType::Pet.label()` 一致）。
pub const PET_WINDOW_LABEL: &str = "pet";

/// 读取桌宠窗口配置（位置 + 缩放）。
pub fn get_config(app: &AppHandle) -> PetWindowConfig {
    pet_window::load_config(app)
}

/// 当前缩放百分比（已夹紧）。
pub fn size_percent(app: &AppHandle) -> f64 {
    pet_window::load_config(app).size_percent_clamped()
}

/// 按当前配置推导逻辑窗口尺寸。
pub fn logical_size(app: &AppHandle) -> (f64, f64) {
    pet_window_logical_size(size_percent(app))
}

/// 设置缩放百分比并立即应用到已存在的窗口。
pub fn set_size_percent(app: &AppHandle, percent: f64) -> Result<PetWindowConfig, String> {
    let mut cfg = pet_window::load_config(app);
    cfg.size_percent = clamp_size_percent(percent);
    if !pet_window::save_config(app, &cfg) {
        return Err("PET_CONFIG_SAVE_FAILED".into());
    }
    apply_size(app)?;
    emit_config(app, &cfg);
    Ok(cfg)
}

/// 按当前配置重设桌宠窗口尺寸，并软恢复到可见显示器（不在拖动中调用）。
pub fn apply_size(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) else {
        return Ok(());
    };
    let (width, height) = logical_size(app);
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("PET_RESIZE_FAILED: {e}"))?;
    // 缩放后夹回可见区（DSH：resize 后 move_pet_window(0,0)）
    ensure_visible(app);
    Ok(())
}

/// 由 AppHandle 持久化位置。
pub fn persist_position(app: &AppHandle, x: i32, y: i32) {
    let mut cfg = pet_window::load_config(app);
    cfg.x = Some(x);
    cfg.y = Some(y);
    let _ = pet_window::save_config(app, &cfg);
}

/// 通知桌宠前端配置已变更。
pub fn emit_config(app: &AppHandle, cfg: &PetWindowConfig) {
    let _ = app.emit_to(PET_WINDOW_LABEL, "pet://window-config", cfg.clone());
}
