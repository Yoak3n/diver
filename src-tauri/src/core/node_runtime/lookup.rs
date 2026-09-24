//! 本机 / 缓存 Node 查找与版本探测。

use std::path::{Path, PathBuf};
use std::process::Command;

use super::process::hidden;
use super::types::{node_file_name, MIN_NODE_MAJOR};

pub(super) fn find_cached_node(cache_root: &Path) -> Option<PathBuf> {
    let name = node_file_name();
    if cache_root.is_dir() {
        if let Ok(rd) = std::fs::read_dir(cache_root) {
            let mut dirs: Vec<PathBuf> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            dirs.reverse(); // 版本目录名形如 node-v22.20.0-win-x64，倒序取更新
            for dir in dirs {
                // zip 解压后是 node-vX-win-x64/node.exe；也兼容直接放在 runtime/
                let direct = dir.join(name);
                if direct.is_file() && is_usable_node(&direct) {
                    return Some(direct);
                }
                // 再向下一层（有时多一层目录）
                if let Ok(rd) = std::fs::read_dir(&dir) {
                    for e in rd.filter_map(|e| e.ok()) {
                        let p = e.path().join(name);
                        if p.is_file() && is_usable_node(&p) {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }
    None
}

pub(super) fn find_system_node() -> Option<PathBuf> {
    // 解析 PATH，避免再 spawn `where`（GUI 父进程下会闪黑窗）。
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let p = dir.join(node_file_name());
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // 常见 Windows 安装位置兜底
    if cfg!(target_os = "windows") {
        let candidates = [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
        ];
        for c in candidates {
            let p = PathBuf::from(c);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

pub(super) fn is_usable_node(node_exe: &Path) -> bool {
    if !node_exe.is_file() {
        return false;
    }
    node_major(node_exe).map(|m| m >= MIN_NODE_MAJOR).unwrap_or(false)
}

pub(super) fn node_major(node_exe: &Path) -> Option<u32> {
    let mut cmd = Command::new(node_exe);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    hidden(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    parse_major(&String::from_utf8_lossy(&out.stdout))
}

fn parse_major(version_line: &str) -> Option<u32> {
    let s = version_line.trim().trim_start_matches('v');
    let major = s.split('.').next()?;
    major.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_major_strips_v_prefix() {
        assert_eq!(parse_major("v22.20.0\n"), Some(22));
        assert_eq!(parse_major("22.1.0"), Some(22));
        assert_eq!(parse_major("garbage"), None);
    }
}
