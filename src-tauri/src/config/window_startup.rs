//! 启动窗口配置：启动时是否自动打开主窗口 / 桌宠窗口。

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{config_dir, load_at, save_at};

/// 配置文件名称。
pub const FILE_NAME: &str = "window-startup.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowStartupConfig {
    /// 启动时自动打开主聊天窗口
    pub auto_open_main: bool,
    /// 启动时自动打开桌宠窗口
    pub auto_open_pet: bool,
}

impl Default for WindowStartupConfig {
    fn default() -> Self {
        Self {
            auto_open_main: true,
            auto_open_pet: true,
        }
    }
}

/// 纯路径读取启动窗口配置（文件不存在时返回默认值）。
pub fn load_config_at(base: &Path) -> WindowStartupConfig {
    load_at(base, FILE_NAME)
}

/// 纯路径保存启动窗口配置，返回是否成功。
pub fn save_config_at(base: &Path, config: &WindowStartupConfig) -> bool {
    save_at(base, FILE_NAME, config)
}

/// 读取启动窗口配置（文件不存在时返回默认值）。
pub fn load_config(app: &AppHandle) -> WindowStartupConfig {
    load_config_at(&config_dir(app))
}

/// 保存启动窗口配置，返回是否成功。
pub fn save_config(app: &AppHandle, config: &WindowStartupConfig) -> bool {
    save_config_at(&config_dir(app), config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_save_at_roundtrip() {
        let dir = std::env::temp_dir().join(format!("diver-ws-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = WindowStartupConfig {
            auto_open_main: false,
            auto_open_pet: true,
        };
        assert!(save_config_at(&dir, &cfg));
        let loaded = load_config_at(&dir);
        assert!(!loaded.auto_open_main);
        assert!(loaded.auto_open_pet);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_at_missing_returns_default() {
        let dir = std::env::temp_dir().join(format!("diver-ws-miss-{}", std::process::id()));
        let cfg = load_config_at(&dir);
        assert!(cfg.auto_open_main);
        assert!(cfg.auto_open_pet);
    }
}
