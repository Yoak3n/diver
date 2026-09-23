//! Node 运行时解析：优先本机 / 应用缓存，缺失时下载官方 zip 到用户数据目录。
//!
//! 安装包不随包 node.exe（体积从 ~70MB 降到 ~15–25MB）。启动 sidecar 前按
//! 下列顺序解析：
//! 1. `DIVER_NODE_BIN` 显式指定
//! 2. 旧版随包 `resources/sidecar/node.exe`（兼容已解压目录）
//! 3. 应用缓存 `%LOCALAPPDATA%/Diver/runtime/node-*/node.exe`
//! 4. PATH / 常见安装目录中的系统 Node（要求 ≥ MIN_NODE_MAJOR）
//! 5. 下载官方发行包到应用缓存（首次需网络；失败给出可操作错误）

mod download;
mod extract;

use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::Manager;

use download::download_and_extract;

/// Windows：子进程不弹控制台黑窗。
#[cfg(target_os = "windows")]
fn hidden(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn hidden(cmd: &mut Command) -> &mut Command {
    cmd
}

/// sidecar（tsx + companion-bundle）要求的最低 Node 主版本。
pub const MIN_NODE_MAJOR: u32 = 22;

/// 首次下载的 Node 版本（Windows/macOS/Linux 官方二进制）。
pub(super) const NODE_DIST_VERSION: &str = "22.20.0";

/// 解析结果。
#[derive(Debug, Clone)]
pub struct NodeRuntime {
    pub node_exe: PathBuf,
    pub source: &'static str,
}

impl NodeRuntime {
    /// `node --version` 解析出的主版本号。
    pub fn major(&self) -> Option<u32> {
        node_major(&self.node_exe)
    }
}

/// 解析可用的 Node；必要时下载到缓存。`push` 用于 UI 日志。
pub fn resolve_node(app: &tauri::AppHandle, push: &mut dyn FnMut(String)) -> Result<NodeRuntime, String> {
    // 1) 显式覆盖
    if let Ok(bin) = std::env::var("DIVER_NODE_BIN") {
        let p = PathBuf::from(&bin);
        if is_usable_node(&p) {
            return Ok(NodeRuntime { node_exe: p, source: "env:DIVER_NODE_BIN" });
        }
        return Err(format!(
            "DIVER_NODE_BIN 指向的 Node 不可用或版本过低（需 ≥ {MIN_NODE_MAJOR}）: {bin}"
        ));
    }

    // 2) 旧版随包 node.exe（升级后 resources 里可能仍在）
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("resources").join("sidecar").join(node_file_name());
        if bundled.is_file() && is_usable_node(&bundled) {
            return Ok(NodeRuntime { node_exe: bundled, source: "bundled" });
        }
    }

    // 3) 应用缓存
    let cache_root = runtime_cache_dir(app);
    if let Some(p) = find_cached_node(&cache_root) {
        return Ok(NodeRuntime { node_exe: p, source: "cache" });
    }

    // 4) 系统 Node
    if let Some(p) = find_system_node() {
        if is_usable_node(&p) {
            return Ok(NodeRuntime { node_exe: p, source: "system" });
        }
    }

    // 5) 下载到缓存
    push(format!(
        "[diver] 未检测到 Node ≥ {MIN_NODE_MAJOR}，正在下载 Node {NODE_DIST_VERSION} …"
    ));
    let node_exe = download_and_extract(app, &cache_root, push)?;
    if !is_usable_node(&node_exe) {
        return Err(format!(
            "下载的 Node 仍不可用: {}（需 ≥ {MIN_NODE_MAJOR}）",
            node_exe.display()
        ));
    }
    Ok(NodeRuntime { node_exe, source: "downloaded" })
}

pub(super) fn node_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}

/// 运行时缓存目录（安装目录外，升级不丢；可手动删除强制重下）。
fn runtime_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    // LOCALAPPDATA/Diver/runtime（Windows）或 ~/.local/share/Diver/runtime 等
    let base = dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .unwrap_or_else(std::env::temp_dir);
    let _ = app; // 保留 AppHandle 便于日后绑定 app 标识目录
    base.join("Diver").join("runtime")
}

fn find_cached_node(cache_root: &Path) -> Option<PathBuf> {
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

fn find_system_node() -> Option<PathBuf> {
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

fn is_usable_node(node_exe: &Path) -> bool {
    if !node_exe.is_file() {
        return false;
    }
    node_major(node_exe).map(|m| m >= MIN_NODE_MAJOR).unwrap_or(false)
}

fn node_major(node_exe: &Path) -> Option<u32> {
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
