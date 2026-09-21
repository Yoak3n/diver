//! 全局快捷键配置：绑定（accelerator → action）的持久化。
//!
//! 热插拔语义：启用/禁用/修改绑定只写这份配置 + 运行时注册/注销，
//! 不需要重启应用（见 `base/shortcut.rs` 的 `ShortcutManager`）。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{load, save};

/// 配置文件名称（壳层配置，`config_dir/shortcuts.json`）。
pub const FILE_NAME: &str = "shortcuts.json";

/// 快捷键可触发的动作。
///
/// 新增动作时：在此枚举加变体 → `base/shortcut.rs` 的 `dispatch_action`
/// 补一个匹配分支（含 UI 展示名）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShortcutAction {
    /// 唤起主聊天窗口（无则创建，有则显示并聚焦）
    ShowMain,
    /// 切换主窗口显隐
    ToggleMain,
    /// 切换桌宠显隐
    TogglePet,
    /// 显示桌宠
    ShowPet,
    /// 收起桌宠
    HidePet,
}

impl ShortcutAction {
    /// UI 展示名（前端快捷键页）。
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::ShowMain => "唤起主窗口",
            Self::ToggleMain => "切换主窗口",
            Self::TogglePet => "切换桌宠",
            Self::ShowPet => "显示桌宠",
            Self::HidePet => "收起桌宠",
        }
    }
}

/// 单条快捷键绑定。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShortcutBinding {
    /// 稳定 id（持久化主键；修改 accelerator/action 时保持不变）。
    pub id: String,
    /// 全局快捷键（global_hotkey 语法：修饰键在前，如 `ctrl+shift+m` / `alt+` 前缀）。
    pub accelerator: String,
    /// 触发的动作。
    pub action: ShortcutAction,
    /// 是否启用（禁用 = 运行时注销，绑定保留在配置里）。
    pub enabled: bool,
}

impl Default for ShortcutBinding {
    fn default() -> Self {
        Self {
            id: String::new(),
            accelerator: String::new(),
            action: ShortcutAction::ShowMain,
            enabled: true,
        }
    }
}

/// 快捷键配置集合。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShortcutsConfig {
    pub bindings: Vec<ShortcutBinding>,
}

impl Default for ShortcutsConfig {
    fn default() -> Self {
        Self {
            bindings: default_bindings(),
        }
    }
}

/// 默认绑定：主窗口唤起 + 桌宠切换。
fn default_bindings() -> Vec<ShortcutBinding> {
    vec![
        ShortcutBinding {
            id: "show-main".into(),
            accelerator: "ctrl+shift+m".into(),
            action: ShortcutAction::ShowMain,
            enabled: true,
        },
        ShortcutBinding {
            id: "toggle-pet".into(),
            accelerator: "ctrl+shift+p".into(),
            action: ShortcutAction::TogglePet,
            enabled: true,
        },
    ]
}

/// 读取快捷键配置（文件不存在或损坏时返回默认值）。
pub fn load_config(app: &AppHandle) -> ShortcutsConfig {
    load(app, FILE_NAME)
}

/// 保存快捷键配置，返回是否成功。
pub fn save_config(app: &AppHandle, config: &ShortcutsConfig) -> bool {
    save(app, FILE_NAME, config)
}
