//! 平台捕获入口：Windows GDI / Linux Wayland / 其它 stub。

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{capture_rect, find_window, list_displays};

#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios")))]
mod wayland;
#[cfg(all(unix, not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios")))]
pub use wayland::{capture_rect, find_window, list_displays};

#[cfg(not(any(
    windows,
    all(unix, not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios"))
)))]
mod stub;
#[cfg(not(any(
    windows,
    all(unix, not(target_os = "macos"), not(target_os = "android"), not(target_os = "ios"))
)))]
pub use stub::{capture_rect, find_window, list_displays};
