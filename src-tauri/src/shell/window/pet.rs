//! 桌宠窗口生命周期与几何管理（对齐成熟桌宠方案的线程/多屏/尺寸约定）。
//!
//! 线程约束（与 tauri-runtime-wry 一致，务必遵守）：
//! - **创建**（`WebviewWindowBuilder::build`）：只允许 app setup 或 **async command**
//!   （异步运行时线程）。主线程同步调用会等事件循环回包而死锁。
//! - **销毁**（`Window::destroy`）：**绝不能**在主线程调用（会 panic）。
//!   统一走本模块的 async command 入口 `set_visible`。
//! - **隐藏语义 = 销毁**：hide 只撤下窗口，WebView/Canvas 仍在跑；销毁才释放
//!   进程与 GPU 资源。重新显示时前端挂载后自行拉状态。

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

use super::manager::Manager as WM;
use diver_geom::*;
use super::schema::{WindowOperationResult, WindowState, WindowType};
use crate::config::pet_window::{self, PetWindowConfig};

/// 桌宠窗口 label（与 `WindowType::Pet.label()` 一致）。
pub const PET_WINDOW_LABEL: &str = "pet";
/// 位置写盘节流：短时间内的多次 Moved 只落盘一次。
static LAST_POS_SAVE_MS: AtomicI64 = AtomicI64::new(0);
/// 最近一次窗口 Moved 的时刻（日志/诊断用）。
static LAST_MOVED_MS: AtomicI64 = AtomicI64::new(0);
/// **系统拖动会话**是否进行中（前端 beginDrag 置位，归位前清除）。
///
/// 不能仅用「最近有没有 Moved」判断拖动：归位动画自身的 set_position 也会触发
/// Moved，若据此跳过动画，拖后过渡会永远出不来。
static PET_DRAGGING: AtomicBool = AtomicBool::new(false);
/// 位置过渡动画代数：新动画自增后，旧动画循环自行退出。
static ANIM_GEN: AtomicU64 = AtomicU64::new(0);
/// Moved 后软限位/跨屏归位的默认过渡时长。
const PET_MOVE_ANIM_MS: u64 = 200;
/// 动画帧间隔（≈60FPS）。
const PET_MOVE_FRAME_MS: u64 = 16;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 记录 Moved 时间戳（init 的 WindowEvent::Moved 调用）。
pub fn note_window_moved() {
    LAST_MOVED_MS.store(now_ms(), Ordering::Relaxed);
}

/// 前端拖动会话开/关（beginDrag / 拖动结束归位前）。
pub fn set_dragging(active: bool) {
    PET_DRAGGING.store(active, Ordering::SeqCst);
    if active {
        note_window_moved();
        cancel_position_animation();
    }
}

/// 系统原生拖动是否进行中：**只看会话标志**，不看 Moved 时间。
fn system_drag_active() -> bool {
    PET_DRAGGING.load(Ordering::SeqCst)
}

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

/// 采样窗口当前位置并节流写盘。
pub fn save_window_position(window: &WebviewWindow) {
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let now = now_ms();
    let last = LAST_POS_SAVE_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < PET_POSITION_SAVE_DEBOUNCE_MS as i64 {
        return;
    }
    LAST_POS_SAVE_MS.store(now, Ordering::Relaxed);
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
    ANIM_GEN.fetch_add(1, Ordering::SeqCst);
}

/// 将窗口平滑移到目标物理坐标（ease-out，约 200ms）。
///
/// - 位移 ≤1px 时直接返回，不启动动画
/// - **仅在拖动会话（PET_DRAGGING）进行中拒绝启动**；归位动画自身的 Moved
///   不会再被误判成「系统拖动」而打断过渡
/// - 新动画会作废旧动画（generation）；用户再次 beginDrag 也会取消
/// - 结束时写盘最终坐标
fn animate_position(app: &AppHandle, window: &WebviewWindow, to_x: i32, to_y: i32) {
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
/// 正确时机：拖动结束后的软恢复、缩放后、显式 command。
///
/// 实际需要挪动时走 **ease-out 过渡**（约 200ms），避免归位瞬间跳变。
///
/// 若最近仍有 Moved（系统拖动进行中），本次调用**不 set_position、不启动动画**，
/// 只更新落盘目标语义上的「已请求」；真正归位由拖动停歇后的下一次调用完成。
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

/// 确保桌宠窗口存在：不存在则按配置创建并定位；已存在则复用。
///
/// **必须**从 async command / setup 调用，禁止主线程同步调用（build 需事件循环回包）。
pub fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
        return Ok(window);
    }
    let result = WM::global().show_window(WindowType::Pet, None);
    match result {
        WindowOperationResult::Created
        | WindowOperationResult::Shown
        | WindowOperationResult::NoAction
        | WindowOperationResult::Hidden => app
            .get_webview_window(PET_WINDOW_LABEL)
            .ok_or_else(|| "PET_WINDOW_CREATE_FAILED".to_string()),
        WindowOperationResult::Failed => Err("PET_WINDOW_CREATE_FAILED".to_string()),
    }
}

/// 显示或收起桌宠。**隐藏 = 销毁窗口实例**。
///
/// 供 async command 调用：本函数在异步运行时线程执行，create/destroy 均安全。
pub fn set_visible(app: &AppHandle, visible: bool) -> Result<(), String> {
    if !visible {
        if let Some(window) = app.get_webview_window(PET_WINDOW_LABEL) {
            window
                .destroy()
                .map_err(|e| format!("PET_WINDOW_DESTROY_FAILED: {e}"))?;
        }
        WM::global().update_window_state(WindowType::Pet, WindowState::NotExist);
        return Ok(());
    }
    let window = ensure_window(app)?;
    let _ = window.show();
    // 桌宠常态不抢焦点：仅 show，不 set_focus。
    WM::global().update_window_state(WindowType::Pet, WindowState::VisibleFocused);
    Ok(())
}

/// 切换桌宠显隐，返回切换后是否可见。
pub fn toggle(app: &AppHandle) -> Result<bool, String> {
    let exists = app.get_webview_window(PET_WINDOW_LABEL).is_some();
    set_visible(app, !exists)?;
    Ok(!exists)
}

/// 通知桌宠前端配置已变更。
pub fn emit_config(app: &AppHandle, cfg: &PetWindowConfig) {
    let _ = app.emit_to(PET_WINDOW_LABEL, "pet://window-config", cfg.clone());
}

/// create 后短暂让出，便于事件循环完成窗口注册。
pub fn brief_yield() {
    std::thread::sleep(Duration::from_millis(10));
}
