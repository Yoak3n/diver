//! 非 Windows / 非 Linux 桌面：捕获未实现。

use crate::types::*;

pub fn list_displays() -> Result<ListDisplaysResult, ShotError> {
    Err(ShotError::unsupported())
}

pub fn find_window(_needle: &str) -> Result<Option<WindowRect>, ShotError> {
    Err(ShotError::unsupported())
}

pub fn capture_rect(_rect: Rect, _plan: EncodePlan, _out_path: &str) -> Result<CaptureFileResult, ShotError> {
    Err(ShotError::unsupported())
}
