//! 自定义图片资产（助手头像 / 应用图标）：base64 ↔ 文件。
//!
//! 存储位置按用途分：
//! - 助手头像：`$COS_HOME/assistant-avatar.<ext>`（每实例一份；sidecar / agent 可用
//!   `read`/`write` 直接读写，无需壳层 IPC）
//! - 应用图标：`<config_dir>/app-icon.<ext>`（应用级品牌位，窗口标题栏等；与实例无关）
//!
//! 纯路径 API 可单测；command 层做 base64 与目录适配。

use std::path::{Path, PathBuf};

/// 允许的图像 MIME。
pub const ALLOWED_MIMES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];

/// 单文件体积上限（1 MiB）。
pub const MAX_BYTES: usize = 1024 * 1024;

/// 助手头像文件名前缀（完整名形如 `assistant-avatar.png`）。
pub const FILE_PREFIX: &str = "assistant-avatar";

/// 应用图标文件名前缀（完整名形如 `app-icon.png`）。
pub const APP_ICON_PREFIX: &str = "app-icon";

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    }
}

fn mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// MIME 是否允许作为图片资产。
pub fn is_allowed_mime(mime: &str) -> bool {
    ALLOWED_MIMES.contains(&mime)
}

/// 扫描目录，返回已有 `<prefix>.<ext>` 路径。
pub fn find_prefixed_file(base: &Path, prefix: &str) -> Option<PathBuf> {
    let rd = std::fs::read_dir(base).ok()?;
    let mut hits: Vec<PathBuf> = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().map(|s| s.to_string_lossy().to_string())?;
        let Some(rest) = name.strip_prefix(&format!("{prefix}.")) else {
            continue;
        };
        if mime_for_ext(rest).is_some() {
            hits.push(p);
        }
    }
    // 多个残留时取 mtime 最新
    hits.sort_by_key(|p| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
    hits.pop()
}

/// 保存 `<prefix>.<ext>`：写入并清掉其它扩展名残留。
pub fn save_prefixed_at(base: &Path, prefix: &str, mime: &str, data: &[u8]) -> Option<PathBuf> {
    if !is_allowed_mime(mime) || data.is_empty() || data.len() > MAX_BYTES {
        return None;
    }
    std::fs::create_dir_all(base).ok()?;
    clear_prefixed_at(base, prefix);
    let path = base.join(format!("{prefix}.{}", ext_for_mime(mime)));
    std::fs::write(&path, data).ok()?;
    Some(path)
}

/// 读取（MIME + 字节）。agent 直接改文件后这里会读到新内容。
pub fn load_prefixed_at(base: &Path, prefix: &str) -> Option<(String, Vec<u8>)> {
    let path = find_prefixed_file(base, prefix)?;
    let ext = path.extension()?.to_string_lossy().to_string();
    let mime = mime_for_ext(&ext)?;
    let data = std::fs::read(&path).ok()?;
    if data.is_empty() {
        return None;
    }
    Some((mime.to_string(), data))
}

/// 清除自定义图片资产。
pub fn clear_prefixed_at(base: &Path, prefix: &str) -> bool {
    let Some(rd) = std::fs::read_dir(base).ok() else {
        return true;
    };
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let Some(name) = p.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        if name.starts_with(prefix) {
            let _ = std::fs::remove_file(&p);
        }
    }
    true
}

/// data URL（`data:image/png;base64,...`）。
pub fn load_prefixed_data_url_at(base: &Path, prefix: &str) -> Option<String> {
    let (mime, data) = load_prefixed_at(base, prefix)?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(data);
    Some(format!("data:{mime};base64,{b64}"))
}

/// 当前资产文件的绝对路径（供设置页展示 / 提示 agent）。
pub fn prefixed_path_hint(base: &Path, prefix: &str) -> String {
    find_prefixed_file(base, prefix)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| base.join(format!("{prefix}.png")).display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "diver-avatar-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn save_load_clear_roundtrip() {
        let dir = tmp();
        let png = [0x89, 0x50, 0x4E, 0x47, 1, 2, 3];
        let p = save_prefixed_at(&dir, FILE_PREFIX, "image/png", &png).unwrap();
        assert!(p.ends_with("assistant-avatar.png"));
        let (mime, data) = load_prefixed_at(&dir, FILE_PREFIX).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, png);
        assert!(load_prefixed_data_url_at(&dir, FILE_PREFIX)
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(clear_prefixed_at(&dir, FILE_PREFIX));
        assert!(load_prefixed_at(&dir, FILE_PREFIX).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_can_overwrite_file_directly() {
        let dir = tmp();
        let a = b"PNGDATA-A";
        save_prefixed_at(&dir, FILE_PREFIX, "image/png", a).unwrap();
        // 模拟 agent 用 write 工具覆盖同路径文件
        std::fs::write(dir.join("assistant-avatar.png"), b"PNGDATA-B").unwrap();
        let (_, data) = load_prefixed_at(&dir, FILE_PREFIX).unwrap();
        assert_eq!(data, b"PNGDATA-B");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_mime_and_oversize() {
        let dir = tmp();
        assert!(save_prefixed_at(&dir, FILE_PREFIX, "image/svg+xml", b"<svg/>").is_none());
        assert!(save_prefixed_at(&dir, FILE_PREFIX, "image/png", b"").is_none());
        let big = vec![0u8; MAX_BYTES + 1];
        assert!(save_prefixed_at(&dir, FILE_PREFIX, "image/png", &big).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_replaces_previous_extension() {
        let dir = tmp();
        save_prefixed_at(&dir, FILE_PREFIX, "image/png", b"aa").unwrap();
        save_prefixed_at(&dir, FILE_PREFIX, "image/jpeg", b"bb").unwrap();
        assert!(dir.join("assistant-avatar.png").exists() == false);
        let (mime, data) = load_prefixed_at(&dir, FILE_PREFIX).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(data, b"bb");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prefixes_are_isolated() {
        let dir = tmp();
        save_prefixed_at(&dir, FILE_PREFIX, "image/png", b"avatar").unwrap();
        save_prefixed_at(&dir, APP_ICON_PREFIX, "image/png", b"icon").unwrap();
        // 清理应用图标不动助手头像，反之亦然
        assert!(clear_prefixed_at(&dir, APP_ICON_PREFIX));
        assert!(load_prefixed_at(&dir, FILE_PREFIX).is_some());
        assert!(load_prefixed_at(&dir, APP_ICON_PREFIX).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
