//! 桌宠位置：持久化、默认落点、跨屏软限位、ease-out 归位动画。

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

use super::{
    now_ms, persist_position, system_drag_active, ANIM_GEN, LAST_POS_SAVE_MS, PET_WINDOW_LABEL,
};
use crate::config::pet_window;
use diver_geom::*;

/// Moved 后软限位/跨屏归位的默认过渡时长。
const PET_MOVE_ANIM_MS: u64 = 200;
/// 动画帧间隔（≈60FPS）。
const PET_MOVE_FRAME_MS: u64 = 16;

/// 采样窗口当前位置并节流写盘。
pub fn save_window_position(window: &WebviewWindow) {
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let now = now_ms();
    let last = LAST_POS_SAVE_MS.load(std::sync::atomic::Ordering::Relaxed);
    if now.saturating_sub(last) < PET_POSITION_SAVE_DEBOUNCE_MS as i64 {
        return;
    }
    LAST_POS_SAVE_MS.store(now, std::sync::atomic::Ordering::Relaxed);
    let app = window.app_handle();
    persist_position(app, pos.x, pos.y);
}

/// 判断物理坐标（窗口左上角）是否与任一可见显示器矩形相交。
pub fn position_on_any_monitor(
    app: &AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    if monitors.is_empty() {
        return false;
    }
    let hit_right = x + width as i32;
    let hit_bottom = y + height as i32;
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        let ml = p.x;
        let mt = p.y;
        let mr = p.x + s.width as i32;
        let mb = p.y + s.height as i32;
        x < mr && hit_right > ml && y < mb && hit_bottom > mt
    })
}

/// 把桌宠放到主屏工作区右下角（默认定位；避开任务栏）。
pub fn place_at_default(window: &WebviewWindow) {
    let app = window.app_handle();
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return;
    };
    let area = *monitor.work_area();
    let Ok(size) = window.outer_size() else {
        return;
    };
    let x = (area.position.x + area.size.width as i32 - size.width as i32 - PET_DEFAULT_MARGIN)
        .max(area.position.x);
    let y = (area.position.y + area.size.height as i32 - size.height as i32 - PET_DEFAULT_MARGIN)
        .max(area.position.y);
    let _ = window.set_position(PhysicalPosition::new(x, y));
    persist_position(app, x, y);
}

/// 创建/显示后：恢复持久化位置，无效（屏幕外）则默认右下角。
pub fn restore_or_default_position(window: &WebviewWindow) {
    let app = window.app_handle();
    let cfg = pet_window::load_config(app);
    let Ok(size) = window.outer_size() else {
        place_at_default(window);
        return;
    };
    if let (Some(x), Some(y)) = (cfg.x, cfg.y) {
        if position_on_any_monitor(app, x, y, size.width, size.height) {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            return;
        }
    }
    place_at_default(window);
}

/// ease-out cubic：起步快、末端缓，适合「归位吸附」的手感。
fn ease_out_cubic(t: f32) -> f32 {
    let u = 1.0 - t.clamp(0.0, 1.0);
    1.0 - u * u * u
}

/// 取消进行中的位置过渡（用户再次拖动前调用，避免动画与 startDragging 抢位置）。
pub fn cancel_position_animation() {
    use std::sync::atomic::Ordering;
    ANIM_GEN.fetch_add(1, Ordering::SeqCst);
}

/// 将窗口平滑移到目标物理坐标（ease-out，约 200ms）。
fn animate_position(app: &AppHandle, window: &WebviewWindow, to_x: i32, to_y: i32) {
    use std::sync::atomic::Ordering;
    if system_drag_active() {
        log::debug!("[pet] skip position animation: system drag session active");
        return;
    }
    let Ok(from) = window.outer_position() else {
        return;
    };
    if (to_x - from.x).abs() <= 1 && (to_y - from.y).abs() <= 1 {
        return;
    }
    let gen = ANIM_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let window = window.clone();
    let app = app.clone();
    let from_x = from.x as f32;
    let from_y = from.y as f32;
    let dx = to_x as f32 - from_x;
    let dy = to_y as f32 - from_y;
    tauri::async_runtime::spawn(async move {
        let start = Instant::now();
        let total = Duration::from_millis(PET_MOVE_ANIM_MS);
        loop {
            // 用户中途再次拖动 → 立刻让位
            if ANIM_GEN.load(Ordering::SeqCst) != gen || system_drag_active() {
                return;
            }
            let elapsed = start.elapsed();
            if elapsed >= total {
                let _ = window.set_position(PhysicalPosition::new(to_x, to_y));
                persist_position(&app, to_x, to_y);
                return;
            }
            let t = elapsed.as_secs_f32() / total.as_secs_f32();
            let e = ease_out_cubic(t);
            let x = (from_x + dx * e).round() as i32;
            let y = (from_y + dy * e).round() as i32;
            let _ = window.set_position(PhysicalPosition::new(x, y));
            tokio::time::sleep(Duration::from_millis(PET_MOVE_FRAME_MS)).await;
        }
    });
}

/// 把窗口夹进「中心点所在 / 最近」显示器的工作区（对齐 DSH `move_pet_window`）。
///
/// **不要在 `Moved` 事件里调用**：系统原生拖动（`startDragging`）进行中时
/// `set_position` 会与拖动循环抢位置，跨屏表现为闪动或被扯回原屏。
pub fn move_by_delta(app: &AppHandle, delta_x: i32, delta_y: i32) -> Result<(), String> {
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "PET_WINDOW_NOT_FOUND".to_string())?;
    let current = window
        .outer_position()
        .map_err(|e| format!("PET_WINDOW_POSITION_FAILED: {e}"))?;
    let size = window
        .outer_size()
        .map_err(|e| format!("PET_WINDOW_SIZE_FAILED: {e}"))?;
    let desired_x = current.x.saturating_add(delta_x);
    let desired_y = current.y.saturating_add(delta_y);
    let center_x = i64::from(desired_x) + i64::from(size.width) / 2;
    let center_y = i64::from(desired_y) + i64::from(size.height) / 2;
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("PET_MONITOR_LIST_FAILED: {e}"))?;
    if monitors.is_empty() {
        return Err("PET_MONITOR_NOT_FOUND: no visible monitor".into());
    }

    // 中心已落在某屏 → 用该屏；跨屏间隙 → 选中心距离最近的屏。
    let monitor = monitors
        .iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            let right = i64::from(p.x) + i64::from(s.width);
            let bottom = i64::from(p.y) + i64::from(s.height);
            center_x >= i64::from(p.x)
                && center_x < right
                && center_y >= i64::from(p.y)
                && center_y < bottom
        })
        .or_else(|| {
            monitors.iter().min_by_key(|m| {
                let p = m.position();
                let s = m.size();
                let left = i64::from(p.x);
                let top = i64::from(p.y);
                let right = left + i64::from(s.width);
                let bottom = top + i64::from(s.height);
                let dx = if center_x < left {
                    left - center_x
                } else if center_x >= right {
                    center_x - right + 1
                } else {
                    0
                };
                let dy = if center_y < top {
                    top - center_y
                } else if center_y >= bottom {
                    center_y - bottom + 1
                } else {
                    0
                };
                dx * dx + dy * dy
            })
        })
        .expect("monitors non-empty");

    // 工作区（避开任务栏）夹紧；窗口比工作区大时贴齐左上角。
    let area = *monitor.work_area();
    let max_x = (area.position.x + area.size.width as i32 - size.width as i32)
        .max(area.position.x);
    let max_y = (area.position.y + area.size.height as i32 - size.height as i32)
        .max(area.position.y);
    let x = desired_x.clamp(area.position.x, max_x);
    let y = desired_y.clamp(area.position.y, max_y);
    if x == current.x && y == current.y {
        persist_position(app, x, y);
        return Ok(());
    }
    // 关键：系统原生拖动仍在进行时绝不 set_position ——
    // 双方同时写窗口坐标会在两个位置间快速切换，表现为「重影/闪烁」。
    if system_drag_active() {
        log::debug!(
            "[pet] move_by_delta deferred: system drag active, skip set_position (target={x},{y})"
        );
        return Ok(());
    }
    animate_position(app, &window, x, y);
    Ok(())
}

/// 拖动/缩放后的软恢复：`move_by_delta(0, 0)`，仅在完全跑出可见区时才会挪动。
pub fn ensure_visible(app: &AppHandle) {
    let _ = move_by_delta(app, 0, 0);
}

/// 兼容旧语义：软限位到最近显示器工作区（拖动结束后调用）。
pub fn clamp_to_current_monitor(app: &AppHandle) {
    ensure_visible(app);
}

/// 按目标显示器工作区定位（右下贴边），带过渡动画，并持久化。
pub fn move_to_monitor(app: &AppHandle, index: usize) -> Result<(), String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("PET_MONITOR_LIST_FAILED: {e}"))?;
    let monitor = monitors
        .get(index)
        .ok_or_else(|| "PET_MONITOR_NOT_FOUND".to_string())?;
    let area = *monitor.work_area();
    let window = app
        .get_webview_window(PET_WINDOW_LABEL)
        .ok_or_else(|| "PET_WINDOW_NOT_FOUND".to_string())?;
    let size = window
        .outer_size()
        .map_err(|e| format!("PET_WINDOW_SIZE_FAILED: {e}"))?;
    let x = (area.position.x + area.size.width as i32 - size.width as i32 - PET_DEFAULT_MARGIN)
        .max(area.position.x);
    let y = (area.position.y + area.size.height as i32 - size.height as i32 - PET_DEFAULT_MARGIN)
        .max(area.position.y);
    animate_position(app, &window, x, y);
    Ok(())
}
