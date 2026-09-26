//! 启动路径、端口与优雅退出令牌解析。

/// sidecar HTTP 服务兜底端口（P1-2 起仅在预选失败时使用）。
///
/// 正常路径见 `ports::resolve_port`：`DIVER_PORT` 显式非 0 固定，否则随机预选。
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

/// 本地服务鉴权令牌（P2-1 / BUG-002）：每次启动壳时随机生成，经 `DIVER_TOKEN`
/// 环境变量注入 sidecar；壳内 HTTP 调用经 [auth_bearer] 携带。debug 构建额外
/// 落盘 `<app_data>/service-token` 供本地脚本自动读取，release 不落盘。
pub fn service_token() -> &'static str {
    static TOKEN: once_cell::sync::OnceCell<String> = once_cell::sync::OnceCell::new();
    TOKEN.get_or_init(|| {
        use std::collections::hash_map::RandomState;
        use std::hash::{BuildHasher, Hasher};
        // RandomState 的种子每进程随机：两组 hasher 输出拼 128 bit 熵。
        let mut h1 = RandomState::new().build_hasher();
        h1.write_u64(0xD1FE_0001);
        let mut h2 = RandomState::new().build_hasher();
        h2.write_u64(0x7A91_0002);
        format!("{:016x}{:016x}", h1.finish(), h2.finish())
    })
}

/// 壳内 HTTP 调用（reqwest）携带的 `Authorization` 头值。
pub fn auth_bearer() -> String {
    format!("Bearer {}", service_token())
}

/// release 构建时 sidecar 资源在 bundle resources 下的相对路径。
#[cfg(not(debug_assertions))]
pub(super) const RELEASE_SIDECAR_DIR: &str = "sidecar";
#[cfg(not(debug_assertions))]
pub(super) const RELEASE_ENTRY: &str = "plugins/companion/src/companion-bundle.ts";
#[cfg(not(debug_assertions))]
pub(super) const RELEASE_BUNDLE_DIR: &str = "bundles/bundle-companion";
#[cfg(not(debug_assertions))]
pub(super) const RELEASE_HARNESS_DIR: &str = "harness";
