//! 桌宠 Live2D 模型资源路径（模型外置为 bundle resources，不编进 diver.exe）。
//!
//! `bundle.resources` 把模型投到 `<resource_dir>/resources/pet/models`；
//! Windows 上 `resource_dir()` 可能带长路径前缀 `\\?\`（core/sidecar/command.rs
//! 有同类处理）：verbatim 路径**不做 Win32 归一化**，一旦混入 `/` 就会被
//! asset 协议以 HTTP 500 拒绝（File::open 报 InvalidInput），所以必须剥前缀
//! 并按段拼接出干净路径。
use std::path::{Path, PathBuf};

/// 剥掉 Windows 长路径前缀：`\\?\UNC\srv\share` → `\\srv\share`，`\\?\X:\` → `X:\`。
pub fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    path.to_path_buf()
}

/// 模型外置目录（安装目录明文文件，用户可自行增删换）。
pub fn models_dir(resource_dir: &Path) -> PathBuf {
    strip_verbatim_prefix(resource_dir)
        .join("resources")
        .join("pet")
        .join("models")
}

/// 模型文件绝对路径：按段拼接（避免 `/` 混入 Windows 路径），拒绝 `..` 逃逸。
/// `rel` 形如 `"Hiyori/Hiyori.model3.json"`。
pub fn model_file(resource_dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut p = models_dir(resource_dir);
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(format!("非法相对路径: {rel}"));
        }
        p.push(seg);
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_dir_strips_verbatim_prefix() {
        let dir = models_dir(Path::new(r"\\?\C:\Diver"));
        assert!(!dir.to_string_lossy().starts_with(r"\\?\"));
        assert!(dir.ends_with(Path::new("resources/pet/models")));
    }

    #[test]
    fn models_dir_plain_input_unchanged() {
        let dir = models_dir(Path::new("C:/Diver"));
        assert!(dir.ends_with(Path::new("resources/pet/models")));
    }

    #[test]
    fn model_file_joins_segments_without_forward_slash() {
        let p = model_file(Path::new(r"\\?\C:\Diver"), "Hiyori/Hiyori.model3.json").unwrap();
        assert!(p.ends_with(Path::new("resources/pet/models/Hiyori/Hiyori.model3.json")));
        #[cfg(windows)]
        assert!(!p.to_string_lossy().contains('/'), "Windows 路径不得混入 /：{p:?}");
    }

    #[test]
    fn model_file_blocks_escape() {
        assert!(model_file(Path::new("C:/Diver"), "../escape.json").is_err());
    }

    #[test]
    fn unc_prefix_maps_to_unc() {
        assert_eq!(
            strip_verbatim_prefix(Path::new(r"\\?\UNC\srv\share")),
            PathBuf::from(r"\\srv\share")
        );
    }
}
