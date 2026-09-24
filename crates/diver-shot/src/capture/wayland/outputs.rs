//! Wayland 输出枚举。
//!
//! 现状：不链 libwayland、不 spawn `wlr-randr`（crates 禁进程）。
//! 合成器专有 D-Bus（Mutter/KWin）结构随版本漂移，先返回 Unsupported，
//! 由 `wayland::list_displays` 退化为单屏占位；portal 截屏仍可用。
//!
//! 后续若要精确多屏 bounds，优先接 zxdg-output / wlr-output-management（纯协议）。

use crate::types::*;

/// 枚举输出。当前实现总是失败 → 上层退化单屏。
pub fn list_wayland_outputs() -> Result<ListDisplaysResult, ShotError> {
    Err(ShotError::new(
        ShotErrorCode::Unsupported,
        "Wayland output enumeration not built-in yet (single virtual display fallback)",
    ))
}
