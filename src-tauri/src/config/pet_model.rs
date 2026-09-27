// 桌宠全局模型选择的持久化真源（跨窗口共享）。
//
// 各窗 WebView2 data 目录互相隔离 localStorage（tauri#8196 规避策略的副作用），
// 「跟随全局」的实例宠与设置页无法用 localStorage 对齐。把全局模型 id 放进壳层
// 配置文件，任何窗口初始化时经 IPC 读到同一真源；localStorage 仅留作浏览器态缓存。

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;

use super::{config_dir, load_at, save_at};

const FILE_NAME: &str = "pet-model.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PetModelConfig {
    /// 全局模型 id；`None` 表示未选择（前端回落 `defaultModelId`）。
    #[serde(default, rename = "globalModelId")]
    pub global_model_id: Option<String>,
}

pub fn load_global_model_at(base: &Path) -> Option<String> {
    let cfg: PetModelConfig = load_at(base, FILE_NAME);
    cfg.global_model_id
}

pub fn save_global_model_at(base: &Path, id: Option<&str>) -> bool {
    let cfg = PetModelConfig {
        global_model_id: id.map(str::to_string),
    };
    save_at(base, FILE_NAME, &cfg)
}

pub fn load_global_model(app: &AppHandle) -> Option<String> {
    load_global_model_at(&config_dir(app))
}

pub fn save_global_model(app: &AppHandle, id: Option<&str>) -> bool {
    save_global_model_at(&config_dir(app), id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_at() {
        let dir = std::env::temp_dir().join(format!("diver-pet-model-{}", std::process::id()));
        assert!(save_global_model_at(&dir, Some("yui-origin")));
        assert_eq!(load_global_model_at(&dir), Some("yui-origin".into()));
        assert!(save_global_model_at(&dir, None));
        assert_eq!(load_global_model_at(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_returns_none() {
        let dir = std::env::temp_dir().join(format!("diver-pet-model-none-{}", std::process::id()));
        assert_eq!(load_global_model_at(&dir), None);
    }
}
