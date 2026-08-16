//! 启动窗口配置：启动时是否自动打开主窗口 / 桌宠窗口。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{load, save};

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

/// 读取启动窗口配置（文件不存在时返回默认值）。
pub fn load_config(app: &AppHandle) -> WindowStartupConfig {
    load(app, FILE_NAME)
}

/// 保存启动窗口配置，返回是否成功。
pub fn save_config(app: &AppHandle, config: &WindowStartupConfig) -> bool {
    save(app, FILE_NAME, config)
}
