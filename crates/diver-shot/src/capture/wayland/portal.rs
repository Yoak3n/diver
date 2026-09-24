//! xdg-desktop-portal Screenshot：`ashpd` + 阻塞执行（不 spawn、不链 libwayland）。

use std::path::PathBuf;

use crate::types::{ShotError, ShotErrorCode};

/// 调 portal 截全屏，返回本地图片路径（通常为 PNG）。
///
/// 某些合成器首次可能弹授权框；`interactive=false` 尽量静默。
pub fn portal_screenshot_png() -> Result<PathBuf, ShotError> {
    // ashpd 为 async API；用 futures-lite 在当前线程阻塞，避免强依赖 tokio。
    futures_lite::future::block_on(async {
        let request = ashpd::desktop::screenshot::Screenshot::request()
            .modal(false)
            .interactive(false)
            .send()
            .await
            .map_err(|e| {
                ShotError::new(
                    ShotErrorCode::CaptureFailed,
                    format!("portal Screenshot request failed (xdg-desktop-portal running?): {e}"),
                )
            })?;

        // ashpd 0.9：Request::response 为同步等待完成。
        let response = request.response().map_err(|e| {
            let msg = e.to_string();
            if msg.contains("cancelled") || msg.contains("Cancelled") {
                ShotError::new(ShotErrorCode::CaptureFailed, "portal screenshot cancelled by user")
            } else {
                ShotError::new(
                    ShotErrorCode::CaptureFailed,
                    format!("portal screenshot failed (compositor denied?): {msg}"),
                )
            }
        })?;

        let uri = response.uri();
        if uri.scheme() == "file" {
            return uri.to_file_path().map_err(|_| {
                ShotError::new(ShotErrorCode::CaptureFailed, format!("bad file uri: {uri}"))
            });
        }
        uri_to_path(uri.as_str())
    })
}

/// `file:///tmp/xxx.png` → PathBuf。
pub fn uri_to_path(uri: &str) -> Result<PathBuf, ShotError> {
    let path = if let Some(rest) = uri.strip_prefix("file://") {
        let rest = rest.strip_prefix("localhost").unwrap_or(rest);
        let normalized = if rest.starts_with('/') {
            rest.to_string()
        } else {
            format!("/{rest}")
        };
        percent_decode(&normalized)
    } else if uri.starts_with('/') {
        uri.to_string()
    } else {
        // ashpd 的 Url 可能已是 file: URL 对象
        if let Ok(url) = url::Url::parse(uri) {
            if url.scheme() == "file" {
                return url
                    .to_file_path()
                    .map_err(|_| ShotError::new(ShotErrorCode::CaptureFailed, format!("bad file uri: {uri}")));
            }
        }
        return Err(ShotError::new(
            ShotErrorCode::CaptureFailed,
            format!("unsupported portal uri: {uri}"),
        ));
    };
    Ok(PathBuf::from(path))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < s.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_file_decoded() {
        let p = uri_to_path("file:///tmp/a%20b.png").unwrap();
        assert!(p.to_string_lossy().contains("a b.png"));
    }

    #[test]
    fn uri_absolute() {
        assert_eq!(uri_to_path("/tmp/x.png").unwrap(), PathBuf::from("/tmp/x.png"));
    }

    #[test]
    fn uri_rejects_http() {
        assert!(uri_to_path("http://x").is_err());
    }
}
