//! 桌宠窗口生命周期与几何管理（对齐成熟桌宠方案的线程/多屏/尺寸约定）。
//!
//! 线程约束（与 tauri-runtime-wry 一致，务必遵守）：
//! - **创建**（`WebviewWindowBuilder::build`）：只允许 app setup 或 **async command**
//!   （异步运行时线程）。主线程同步调用会等事件循环回包而死锁。
//! - **销毁**（`Window::destroy`）：**绝不能**在主线程调用（会 panic）。
//!   统一走本模块的 async command 入口 `set_visible`。
//! - **隐藏语义 = 销毁**：hide 只撤下窗口，WebView/Canvas 仍在跑；销毁才释放
//!   进程与 GPU 资源。重新显示时前端挂载后自行拉状态。

mod position;

pub use position::{
    cancel_position_animation, clamp_to_current_monitor, ensure_visible, move_by_delta,
    move_to_monitor, place_at_default, position_on_any_monitor, restore_or_default_position,
    save_window_position,
};

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use super::manager::Manager as WM;
use super::schema::{WindowOperationResult, WindowState, WindowType};
use crate::config::pet_window::{self, PetWindowConfig};
use diver_geom::*;

/// 桌宠窗口 label（与 `WindowType::Pet.label()` 一致）。
pub const PET_WINDOW_LABEL: &str = "pet";
/// 位置写盘节流：短时间内的多次 Moved 只落盘一次。
pub(super) static LAST_POS_SAVE_MS: AtomicI64 = AtomicI64::new(0);
/// 最近一次窗口 Moved 的时刻（日志/诊断用）。
static LAST_MOVED_MS: AtomicI64 = AtomicI64::new(0);
/// **系统拖动会话**是否进行中（前端 beginDrag 置位，归位前清除）。
pub(super) static PET_DRAGGING: AtomicBool = AtomicBool::new(false);
/// 位置过渡动画代数：新动画自增后，旧动画循环自行退出。
pub(super) static ANIM_GEN: AtomicU64 = AtomicU64::new(0);

pub(super) fn now_ms() -> i64 {
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
pub(super) fn system_drag_active() -> bool {
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
