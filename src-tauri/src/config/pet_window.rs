//! 桌宠窗口持久化：位置 + 缩放百分比。
//!
//! 单独文件、不与主窗口几何混写（主窗口配置在 sidecar/设置侧）。
//! 位置只存物理坐标；恢复前必须校验是否落在任一可见显示器内。

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{config_dir, load_at, save_at};
use diver_geom::{clamp_size_percent, PET_SIZE_DEFAULT_PERCENT};

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

/// 纯路径读取（测试 / 无 AppHandle 场景）。
pub fn load_config_at(base: &Path) -> PetWindowConfig {
    let mut cfg: PetWindowConfig = load_at(base, FILE_NAME);
    cfg.size_percent = cfg.size_percent_clamped();
    cfg
}

/// 纯路径写入（测试 / 无 AppHandle 场景）。
pub fn save_config_at(base: &Path, config: &PetWindowConfig) -> bool {
    let mut cfg = config.clone();
    cfg.size_percent = cfg.size_percent_clamped();
    save_at(base, FILE_NAME, &cfg)
}

pub fn load_config(app: &AppHandle) -> PetWindowConfig {
    load_config_at(&config_dir(app))
}

pub fn save_config(app: &AppHandle, config: &PetWindowConfig) -> bool {
    save_config_at(&config_dir(app), config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_save_at_roundtrip() {
        let dir = std::env::temp_dir().join(format!("diver-pet-win-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = PetWindowConfig {
            x: Some(12),
            y: Some(-8),
            size_percent: 120.0,
        };
        assert!(save_config_at(&dir, &cfg));
        let loaded = load_config_at(&dir);
        assert_eq!(loaded.x, Some(12));
        assert_eq!(loaded.y, Some(-8));
        assert!((loaded.size_percent - 120.0).abs() < f64::EPSILON);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_at_missing_returns_default() {
        let dir = std::env::temp_dir().join(format!("diver-pet-win-miss-{}", std::process::id()));
        let cfg = load_config_at(&dir);
        assert_eq!(cfg.x, None);
        assert!((cfg.size_percent - PET_SIZE_DEFAULT_PERCENT).abs() < f64::EPSILON);
    }
}
