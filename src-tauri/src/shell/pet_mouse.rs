//! 桌宠全局鼠标位置流（点击穿透恢复，对齐成熟桌宠方案）。
//!
//! 背景：整窗 `setIgnoreCursorEvents(true)` 后（Windows 上为 WS_EX_TRANSPARENT），
//! WebView **收不到任何鼠标事件**（mouseenter/mousemove 均不触发）。若前端只靠
//! 自身 mousemove 感知光标，会陷入「穿透后无法恢复交互」死锁。
//!
//! 方案：Rust 独立线程轮询全局光标，限频通过 `device-mouse-move` 事件推给桌宠
//! WebView。前端用窗口几何 + 命中区判定是否解除穿透；穿透态下事件流仍在，
//! 死锁解除。
//!
//! 平台：当前用 `mouse_position` 轮询（Windows 内部为 GetCursorPos，不装钩子、
//! 不碰 IME）。emit 节流 16ms；鼠标静止时坐标不变则不发事件。

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, WebviewWindow};

/// 桌宠前端监听的全局鼠标事件名。
pub const PET_MOUSE_MOVE_EVENT: &str = "device-mouse-move";
/// emit 节流间隔（≈60FPS）。
const THROTTLE_INTERVAL: Duration = Duration::from_millis(16);
/// 光标轮询间隔（Windows GetCursorPos 量级；只写共享槽）。
const CURSOR_POLL_INTERVAL: Duration = Duration::from_millis(8);

/// 物理像素光标位置（虚拟屏幕全局坐标，副屏可为负）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct MouseCursorPos {
    pub x: f64,
    pub y: f64,
}

/// 进程级鼠标流状态：幂等启动 + 当前接收窗口。
///
/// 桌宠「收起=销毁」后重建的是新窗口；前端每次挂载调用
/// `start_pet_mouse_stream` 刷新接收句柄（revision 自增强制补发一次坐标）。
#[derive(Default)]
pub struct PetMouseStreamState {
    started: Arc<AtomicBool>,
    emitter: Arc<Mutex<Option<WebviewWindow>>>,
    revision: Arc<AtomicUsize>,
}

impl PetMouseStreamState {
    /// 启动/重绑鼠标流（幂等）。由桌宠 WebView 在 mount 时调用。
    pub fn start(&self, window: WebviewWindow) {
        bind_emitter(&self.emitter, &self.revision, window);
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let started_on_error = self.started.clone();
        let latest: Arc<Mutex<Option<MouseCursorPos>>> = Arc::default();

        // 监听线程：只写最新坐标到共享槽。
        let store = latest.clone();
        thread::spawn(move || {
            if let Err(error) = listen_cursor(store) {
                log::error!("[pet-mouse] cursor listen failed: {error}");
                started_on_error.store(false, Ordering::SeqCst);
            }
        });

        // 节流线程：16ms 读槽，变化才 emit；窗口重建后强制补发。
        let emitter = self.emitter.clone();
        let revision = self.revision.clone();
        thread::spawn(move || {
            let mut last_sent: Option<MouseCursorPos> = None;
            let mut bound_revision = revision.load(Ordering::SeqCst);
            loop {
                let current_revision = revision.load(Ordering::SeqCst);
                let rebound = current_revision != bound_revision;
                bound_revision = current_revision;
                let current = latest.lock().map(|mut g| g.take()).unwrap_or(None);
                if let Some(pos) = current {
                    if rebound || last_sent != Some(pos) {
                        last_sent = Some(pos);
                        if let Some(target) = emitter.lock().ok().and_then(|g| g.clone()) {
                            let _ = target.emit(PET_MOUSE_MOVE_EVENT, pos);
                        }
                    }
                }
                thread::sleep(THROTTLE_INTERVAL);
            }
        });
    }
}

fn bind_emitter(
    slot: &Arc<Mutex<Option<WebviewWindow>>>,
    revision: &Arc<AtomicUsize>,
    window: WebviewWindow,
) {
    if let Ok(mut current) = slot.lock() {
        *current = Some(window);
    }
    revision.fetch_add(1, Ordering::SeqCst);
}

fn listen_cursor(store: Arc<Mutex<Option<MouseCursorPos>>>) -> Result<(), String> {
    use mouse_position::mouse_position::Mouse;
    loop {
        if let Mouse::Position { x, y } = Mouse::get_mouse_position() {
            if let Ok(mut slot) = store.lock() {
                *slot = Some(MouseCursorPos {
                    x: x as f64,
                    y: y as f64,
                });
            }
        }
        thread::sleep(CURSOR_POLL_INTERVAL);
    }
}
