//! 桌宠 Live2D 模型资源路径（模型外置为 bundle resources，不编进 diver.exe）。
//!
//! `bundle.resources` 把模型投到 `<resource_dir>/resources/pet/models`；
//! Windows 上 `resource_dir()` 返回 exe 所在目录，需再拼 `resources` 前缀
//! （与 `core/sidecar/command.rs` 的 sidecar 解析同构）。
use std::path::{Path, PathBuf};

/// 模型外置目录（安装目录明文文件，用户可自行增删换）。
pub fn models_dir(resource_dir: &Path) -> PathBuf {
    resource_dir.join("resources").join("pet").join("models")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_dir_lives_under_resources() {
        let dir = models_dir(Path::new("C:/Diver"));
        assert!(dir.ends_with(Path::new("resources/pet/models")));
    }
}
