//! 应用配置中心：统一管理本机持久化配置。
//!
//! 配置分两类存放：
//! - **壳层配置**（`app_config_dir`，如 `window-startup.json`）：由 Tauri 壳自己
//!   读写，sidecar 不读取，放在 `config_dir` 下即可。
//! - **数据家园配置**（`cos_home`，即 sidecar 的 `COS_HOME`，如 `mcp-servers.json`）：
//!   由 sidecar 插件读取，必须放在 `$COS_HOME` 下（与 `diver-settings.json` 同目录），
//!   见 [cos_home]。
//! 新增配置时，在此目录下添加一个子模块，并按读取方选择 [config_dir] / [cos_home]。

pub mod mcp;
pub mod pet_window;
pub mod profile;
pub mod shortcuts;
pub mod tts;
pub mod window_startup;

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tauri::{AppHandle, Manager as TauriManager};

/// 应用配置目录（壳层配置所在的目录）。
pub fn config_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// cos 数据家园根目录（与 sidecar 注入的 `COS_HOME` 完全一致）。
///
/// - debug 构建：仓库 `harness/.cos-home`（sidecar 的 dev 形态，见
///   `sidecar.rs` 的 debug 分支）。
/// - release 构建：`<app_data_dir>/cos`（与安装目录隔离，升级不丢数据）。
///
/// `mcp-servers.json` 等由 sidecar 插件读取的配置必须放在这里
/// （与 `diver-settings.json` 同目录），否则插件按 `$COS_HOME/...` 找不到文件。
pub fn cos_home(app: &AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        // debug 分支只依赖环境变量，不需要 AppHandle。
        let _ = app;
        cos_home_at(&std::env::temp_dir())
    }
    #[cfg(not(debug_assertions))]
    {
        let data = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| config_dir(app));
        cos_home_at(&data)
    }
}

/// 纯路径版 cos_home：`base` 为 release 形态的 `app_data_dir`（debug 忽略）。
pub fn cos_home_at(base: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let _ = base;
        let harness = std::env::var("DIVER_HARNESS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                // 默认相对仓库布局：src-tauri 的上一级目录下的 harness/
                let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                manifest.parent().unwrap_or(&manifest).join("harness")
            });
        harness.join(".cos-home")
    }
    #[cfg(not(debug_assertions))]
    {
        base.join("cos")
    }
}

/// 从配置文件读取并反序列化指定类型的配置。
///
/// 文件不存在或内容解析失败时返回 `T::default()`，保证应用始终可用。
pub fn load<T>(app: &AppHandle, file_name: &str) -> T
where
    T: DeserializeOwned + Default,
{
    load_at(&config_dir(app), file_name)
}

/// 将配置序列化为 JSON 并写入配置文件，必要时自动创建目录。
///
/// 返回是否写盘成功。
pub fn save<T>(app: &AppHandle, file_name: &str, value: &T) -> bool
where
    T: Serialize,
{
    save_at(&config_dir(app), file_name, value)
}

/// 从 `base` 目录下的文件读取并反序列化指定类型的配置。
///
/// 文件不存在或内容解析失败时返回 `T::default()`，保证应用始终可用。
pub fn load_at<T>(base: &Path, file_name: &str) -> T
where
    T: DeserializeOwned + Default,
{
    std::fs::read_to_string(base.join(file_name))
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

/// 将配置序列化为 JSON 并写入 `base` 目录下的文件，必要时自动创建目录。
///
/// 返回是否写盘成功。
pub fn save_at<T>(base: &Path, file_name: &str, value: &T) -> bool
where
    T: Serialize,
{
    let path = base.join(file_name);
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
    struct Demo {
        n: u32,
        s: String,
    }

    #[test]
    fn load_save_at_roundtrip() {
        let dir = std::env::temp_dir().join(format!("diver-cfg-io-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let v = Demo {
            n: 7,
            s: "你好".into(),
        };
        assert!(save_at(&dir, "demo.json", &v));
        let loaded: Demo = load_at(&dir, "demo.json");
        assert_eq!(loaded, v);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_at_missing_returns_default() {
        let dir = std::env::temp_dir().join(format!("diver-cfg-miss-{}", std::process::id()));
        let loaded: Demo = load_at(&dir, "nope.json");
        assert_eq!(loaded, Demo::default());
    }
}
