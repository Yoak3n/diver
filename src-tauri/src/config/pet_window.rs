//! 桌宠窗口持久化：位置 + 缩放百分比。
//!
//! 单独文件、不与主窗口几何混写（主窗口配置在 sidecar/设置侧）。
//! 位置只存物理坐标；恢复前必须校验是否落在任一可见显示器内。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{load, save};
use crate::base::window::pet_geom::{clamp_size_percent, PET_SIZE_DEFAULT_PERCENT};

pub const FILE_NAME: &str = "pet-window.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PetWindowConfig {
    /// 窗口左上角物理 X；None = 从未拖动，走默认定位。
    pub x: Option<i32>,
    /// 窗口左上角物理 Y。
    pub y: Option<i32>,
    /// 缩放百分比（50–200）。
    pub size_percent: f64,
}

impl Default for PetWindowConfig {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            size_percent: PET_SIZE_DEFAULT_PERCENT,
        }
    }
}

impl PetWindowConfig {
    /// 合法缩放百分比（越界/非法收敛为默认区间）。
    pub fn size_percent_clamped(&self) -> f64 {
        clamp_size_percent(self.size_percent)
    }
}

pub fn load_config(app: &AppHandle) -> PetWindowConfig {
    let mut cfg: PetWindowConfig = load(app, FILE_NAME);
    cfg.size_percent = cfg.size_percent_clamped();
    cfg
}

pub fn save_config(app: &AppHandle, config: &PetWindowConfig) -> bool {
    let mut cfg = config.clone();
    cfg.size_percent = cfg.size_percent_clamped();
    save(app, FILE_NAME, &cfg)
}
