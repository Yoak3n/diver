//! 助手头像：用户/agent 可自定义的聊天头像。
//!
//! **存储位置**：`$COS_HOME/assistant-avatar.<ext>`（png/jpg/webp/gif）。
//! 放在 cos_home 是为了让 sidecar / agent 用 `read`/`write` 直接读写，
//! 无需壳层 IPC；壳层只负责 UI 展示与用户在设置里的上传入口。
//!
//! 纯路径 API 可单测；command 层做 base64 与 `cos_home` 适配。

use std::path::{Path, PathBuf};

/// 允许的图像 MIME。
pub const ALLOWED_MIMES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];

/// 单文件体积上限（1 MiB）。
pub const MAX_BYTES: usize = 1024 * 1024;

/// 文件名前缀（完整名形如 `assistant-avatar.png`）。
pub const FILE_PREFIX: &str = "assistant-avatar";

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

/// MIME 是否允许作为头像。
pub fn is_allowed_mime(mime: &str) -> bool {
    ALLOWED_MIMES.contains(&mime)
}

/// 扫描目录，返回已有头像路径（`assistant-avatar.<ext>`）。
pub fn find_avatar_file(base: &Path) -> Option<PathBuf> {
    let rd = std::fs::read_dir(base).ok()?;
    let mut hits: Vec<PathBuf> = Vec::new();
    for e in rd.filter_map(|e| e.ok()) {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let name = p.file_name().map(|s| s.to_string_lossy().to_string())?;
        let Some(rest) = name.strip_prefix(&format!("{FILE_PREFIX}.")) else {
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

/// 保存头像：写入 `assistant-avatar.<ext>`，并清掉其它扩展名残留。
pub fn save_avatar_at(base: &Path, mime: &str, data: &[u8]) -> Option<PathBuf> {
    if !is_allowed_mime(mime) || data.is_empty() || data.len() > MAX_BYTES {
        return None;
    }
    std::fs::create_dir_all(base).ok()?;
    clear_avatar_at(base);
    let path = base.join(format!("{FILE_PREFIX}.{}", ext_for_mime(mime)));
    std::fs::write(&path, data).ok()?;
    Some(path)
}

/// 读取（MIME + 字节）。agent 直接改文件后这里会读到新内容。
pub fn load_avatar_at(base: &Path) -> Option<(String, Vec<u8>)> {
    let path = find_avatar_file(base)?;
    let ext = path.extension()?.to_string_lossy().to_string();
    let mime = mime_for_ext(&ext)?;
    let data = std::fs::read(&path).ok()?;
    if data.is_empty() {
        return None;
    }
    Some((mime.to_string(), data))
}

/// 清除自定义头像。
pub fn clear_avatar_at(base: &Path) -> bool {
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
        if name.starts_with(FILE_PREFIX) {
            let _ = std::fs::remove_file(&p);
        }
    }
    true
}

/// data URL（`data:image/png;base64,...`）。
pub fn load_avatar_data_url_at(base: &Path) -> Option<String> {
    let (mime, data) = load_avatar_at(base)?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(data);
    Some(format!("data:{mime};base64,{b64}"))
}

/// 当前头像文件的绝对路径（供设置页展示 / 提示 agent）。
pub fn avatar_path_hint(base: &Path) -> String {
    find_avatar_file(base)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| {
            base.join(format!("{FILE_PREFIX}.png"))
                .display()
                .to_string()
        })
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
        let p = save_avatar_at(&dir, "image/png", &png).unwrap();
        assert!(p.ends_with("assistant-avatar.png"));
        let (mime, data) = load_avatar_at(&dir).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, png);
        assert!(load_avatar_data_url_at(&dir).unwrap().starts_with("data:image/png;base64,"));
        assert!(clear_avatar_at(&dir));
        assert!(load_avatar_at(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn agent_can_overwrite_file_directly() {
        let dir = tmp();
        let a = b"PNGDATA-A";
        save_avatar_at(&dir, "image/png", a).unwrap();
        // 模拟 agent 用 write 工具覆盖同路径文件
        std::fs::write(dir.join("assistant-avatar.png"), b"PNGDATA-B").unwrap();
        let (_, data) = load_avatar_at(&dir).unwrap();
        assert_eq!(data, b"PNGDATA-B");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_mime_and_oversize() {
        let dir = tmp();
        assert!(save_avatar_at(&dir, "image/svg+xml", b"<svg/>").is_none());
        assert!(save_avatar_at(&dir, "image/png", b"").is_none());
        let big = vec![0u8; MAX_BYTES + 1];
        assert!(save_avatar_at(&dir, "image/png", &big).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_replaces_previous_extension() {
        let dir = tmp();
        save_avatar_at(&dir, "image/png", b"aa").unwrap();
        save_avatar_at(&dir, "image/jpeg", b"bb").unwrap();
        assert!(dir.join("assistant-avatar.png").exists() == false);
        let (mime, data) = load_avatar_at(&dir).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(data, b"bb");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
