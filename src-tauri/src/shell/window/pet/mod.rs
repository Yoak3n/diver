//! 桌宠窗口生命周期与几何管理（对齐成熟桌宠方案的线程/多屏/尺寸约定）。
//!
//! 线程约束（与 tauri-runtime-wry 一致，务必遵守）：
//! - **创建**（`WebviewWindowBuilder::build`）：只允许 app setup 或 **async command**
//!   （异步运行时线程）。主线程同步调用会等事件循环回包而死锁。
//! - **销毁**（`Window::destroy`）：**绝不能**在主线程调用（会 panic）。
//!   统一走本模块的 async command 入口 `set_visible`。
//! - **隐藏语义 = 销毁**：hide 只撤下窗口，WebView/Canvas 仍在跑；销毁才释放
//!   进程与 GPU 资源。重新显示时前端挂载后自行拉状态。

mod flags;
mod lifecycle;
mod position;
mod window;

pub use flags::{note_window_moved, set_dragging};
pub use lifecycle::{brief_yield, ensure_window, set_visible, toggle};
pub use position::{
    cancel_position_animation, clamp_to_current_monitor, ensure_visible, move_by_delta,
    move_to_monitor, place_at_default, position_on_any_monitor, restore_or_default_position,
    save_window_position,
};
pub use window::{
    apply_size, emit_config, get_config, logical_size, persist_position, set_size_percent,
    size_percent, PET_WINDOW_LABEL,
};
