//! 启动路径、端口与优雅退出令牌解析。

use std::path::PathBuf;

/// 启动时缓存的 COS_HOME：stop() 清 restart 标志用（无 AppHandle）。
pub(super) static LAST_COS_HOME: once_cell::sync::OnceCell<PathBuf> = once_cell::sync::OnceCell::new();

/// sidecar HTTP 服务默认端口（可用环境变量 DIVER_PORT 覆盖）。
///
/// 高位端口（动态/私有区间 49152–65535）：本服务非常驻、使用频率低，
/// 低位段易与常用服务冲突，故迁到高位；53620 取"5 + 旧 3620"便于记忆。
pub const DEFAULT_PORT: u16 = 53620;

/// 优雅退出令牌：每次启动 sidecar 时随机生成，经 `DIVER_SHUTDOWN_TOKEN` 环境变量
/// 注入。`stop()` 发起的 `POST /api/shutdown` 必须携带该令牌，防止 sidecar 上
/// 同源静态 UI / 本地恶意脚本把常驻 agent 进程关掉（sidecar 只监听 127.0.0.1）。
pub(super) fn shutdown_token() -> &'static str {
    static TOKEN: once_cell::sync::OnceCell<String> = once_cell::sync::OnceCell::new();
    TOKEN.get_or_init(|| {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let pid = std::process::id();
        format!("diver-shutdown-{pid}-{nanos:x}")
    })
}

/// release 构建时 sidecar 资源在 bundle resources 下的相对路径。
#[cfg(not(debug_assertions))]
pub(super) const RELEASE_SIDECAR_DIR: &str = "sidecar";
#[cfg(not(debug_assertions))]
pub(super) const RELEASE_ENTRY: &str = "harness/packages/sidecar/src/companion-bundle.ts";
#[cfg(not(debug_assertions))]
pub(super) const RELEASE_BUNDLE_DIR: &str = "bundles/bundle-companion";
#[cfg(not(debug_assertions))]
pub(super) const RELEASE_HARNESS_DIR: &str = "harness";
#[cfg(not(debug_assertions))]
pub(super) const RELEASE_PLUGINS_DIR: &str = "plugins";
