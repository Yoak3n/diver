//! 领域类型：矩形 / 显示器 / 编码计划 / 捕获结果 / 错误码。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayInfo {
    pub index: u32,
    pub name: String,
    pub primary: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub work: Rect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListDisplaysResult {
    pub displays: Vec<DisplayInfo>,
    pub virtual_screen: Rect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowRect {
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub iconic: bool,
}

/// 编码计划：缩放上限 + JPEG 质量 + 体积硬顶。
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EncodePlan {
    pub max_width: u32,
    pub quality: u8,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureFileResult {
    pub path: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub source: Rect,
    pub format: String,
    pub quality: u8,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShotErrorCode {
    Unsupported,
    CaptureFailed,
    EncodeFailed,
    Io,
    InvalidRect,
    WindowNotFound,
}

impl ShotErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsupported => "SHOT_UNSUPPORTED",
            Self::CaptureFailed => "SHOT_CAPTURE_FAILED",
            Self::EncodeFailed => "SHOT_ENCODE_FAILED",
            Self::Io => "SHOT_IO",
            Self::InvalidRect => "SHOT_INVALID_RECT",
            Self::WindowNotFound => "SHOT_WINDOW_NOT_FOUND",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ShotError {
    pub code: ShotErrorCode,
    pub message: String,
}

impl ShotError {
    pub fn new(code: ShotErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn unsupported() -> Self {
        Self::new(
            ShotErrorCode::Unsupported,
            "screenshot capture is implemented on Windows (GDI) and Linux Wayland (xdg-desktop-portal)",
        )
    }
}
