//! Node 运行时领域类型与平台常量。

use std::path::PathBuf;

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
        super::lookup::node_major(&self.node_exe)
    }
}

/// 平台可执行文件名（`node.exe` / `node`）。
pub(super) fn node_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}
