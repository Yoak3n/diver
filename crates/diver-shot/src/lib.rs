//! Diver 屏幕捕获引擎。
//!
//! 职责：枚举显示器、按矩形捕获、JPEG 小体积编码。
//! 平台：Windows GDI；Linux Wayland（xdg-desktop-portal）；其它 stub。
//! 无 Tauri / HTTP / 进程依赖；`services/screenshot` 薄适配调用。

pub mod capture;
pub mod encode;
pub mod geometry;
pub mod types;

pub use capture::{capture_rect, find_window, list_displays};
pub use encode::encode_jpeg_ladder;
pub use types::{
    CaptureFileResult, DisplayInfo, EncodePlan, ListDisplaysResult, Rect, ShotError, ShotErrorCode,
    WindowRect,
};
