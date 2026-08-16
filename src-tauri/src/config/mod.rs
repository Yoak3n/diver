//! 应用配置中心：统一管理本机持久化配置。
//!
//! 所有配置以 JSON 文件形式保存在 Tauri 的应用配置目录（`app_config_dir`）下。
//! 新增配置时，在此目录下添加一个子模块，并用 [load]、[save] 完成读写即可。

pub mod window_startup;

use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::{AppHandle, Manager as TauriManager};

/// 应用配置目录（所有配置文件所在的目录）。
pub fn config_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 配置文件路径：`<config_dir>/<file_name>`。
pub fn config_file(app: &AppHandle, file_name: &str) -> PathBuf {
    config_dir(app).join(file_name)
}

/// 从配置文件读取并反序列化指定类型的配置。
///
/// 文件不存在或内容解析失败时返回 `T::default()`，保证应用始终可用。
pub fn load<T>(app: &AppHandle, file_name: &str) -> T
where
    T: DeserializeOwned + Default,
{
    std::fs::read_to_string(config_file(app, file_name))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

/// 将配置序列化为 JSON 并写入配置文件，必要时自动创建目录。
///
/// 返回是否写盘成功。
pub fn save<T>(app: &AppHandle, file_name: &str, value: &T) -> bool
where
    T: Serialize,
{
    let path = config_file(app, file_name);
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return false;
        }
    }

    serde_json::to_string_pretty(value)
        .ok()
        .and_then(|json| std::fs::write(&path, json).ok())
        .is_some()
}
