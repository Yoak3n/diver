//! 行预览截断与路径展示辅助。

use std::path::Path;

/// 把绝对路径相对 workdir 展示；不在 workdir 下则原样。
pub(super) fn display_path(path: &Path, workdir: &str) -> String {
    if !path.is_absolute() {
        return path.to_string_lossy().into_owned();
    }
    let workdir_path = Path::new(workdir);
    if let Ok(rel) = path.strip_prefix(workdir_path) {
        if rel.as_os_str().is_empty() {
            return ".".to_string();
        }
        return rel.to_string_lossy().into_owned();
    }
    path.to_string_lossy().into_owned()
}

/// 按 UTF-8 边界把一行预览截断到 max_bytes 字节；超长加后缀。
pub(super) fn preview_line(line: &str, max_bytes: usize) -> String {
    if line.len() <= max_bytes {
        return line.to_string();
    }
    let mut end = 0;
    let mut bytes = 0;
    for (idx, ch) in line.char_indices() {
        let ch_len = ch.len_utf8();
        if bytes + ch_len > max_bytes {
            break;
        }
        bytes += ch_len;
        end = idx + ch_len;
    }
    let mut result = line[..end].to_string();
    result.push_str("... (line truncated)");
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn display_path_relative_under_workdir() {
        let work = std::env::temp_dir().join("diver-dp-work");
        let p = work.join("src").join("a.ts");
        let rel = display_path(&p, &work.to_string_lossy());
        assert_eq!(rel, Path::new("src").join("a.ts").to_string_lossy());
    }

    #[test]
    fn display_path_outside_workdir_kept() {
        let work = std::env::temp_dir().join("diver-dp-work");
        let p = std::env::temp_dir().join("diver-dp-other").join("a.ts");
        assert_eq!(display_path(&p, &work.to_string_lossy()), p.to_string_lossy());
    }

    #[test]
    fn display_path_same_dir_is_dot() {
        let work = std::env::temp_dir().join("diver-dp-work");
        assert_eq!(display_path(&work, &work.to_string_lossy()), ".");
    }

    #[test]
    fn display_path_non_absolute_returned_as_is() {
        let p = PathBuf::from("src").join("a.ts");
        assert_eq!(display_path(&p, "work"), p.to_string_lossy());
    }

    #[test]
    fn preview_short_line_unchanged() {
        assert_eq!(preview_line("hello", 100), "hello");
    }

    #[test]
    fn preview_truncates_utf8_safe() {
        let long = "啊".repeat(100);
        let out = preview_line(&long, 10);
        assert!(out.ends_with("... (line truncated)"));
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }
}
