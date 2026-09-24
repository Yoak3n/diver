//! 桌宠窗口会话标志与时间戳（拖动 / Moved / 动画代数）。

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use super::position::cancel_position_animation;

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
