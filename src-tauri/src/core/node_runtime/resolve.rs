//! Node 解析主流程：env → 随包 → 缓存 → 系统 → 下载。

use std::path::PathBuf;

use tauri::Manager;

use super::download::download_and_extract;
use super::lookup::{find_cached_node, find_system_node, is_usable_node};
use super::types::{node_file_name, NodeRuntime, MIN_NODE_MAJOR, NODE_DIST_VERSION};

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

/// 运行时缓存目录（安装目录外，升级不丢；可手动删除强制重下）。
fn runtime_cache_dir(_app: &tauri::AppHandle) -> PathBuf {
    // LOCALAPPDATA/Diver/runtime（Windows）或 ~/.local/share/Diver/runtime 等
    let base = dirs::data_local_dir()
        .or_else(|| dirs::data_dir())
        .unwrap_or_else(std::env::temp_dir);
    base.join("Diver").join("runtime")
}
