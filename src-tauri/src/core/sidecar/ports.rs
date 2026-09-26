//! 端口协商（P1-2）：随机预选 + 就绪行实际端口解析。
//!
//! 语义：`DIVER_PORT` 显式非 0 → 固定端口（调试 / 兼容）；0 / 缺省 → 壳预选
//! 空闲端口（bind `127.0.0.1:0` 取回端口后立即释放），经 `DIVER_PORT` 传给 sidecar。
//! 壳侧预选（而非 Node bind 随机后回报）是为了让端口在启动全程已知：
//! release 窗口 URL、`api_base_url()`、启动预检都在 sidecar 就绪前消费它。
//! 就绪行 `DIVER_READY http://127.0.0.1:{port}` 仍解析核对，实际端口以 Node 为准。

use super::paths::DEFAULT_PORT;

/// 解析当前进程应使用的 sidecar 端口。
pub fn resolve_port() -> u16 {
    let explicit = std::env::var("DIVER_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|p| *p != 0);
    explicit.or_else(pick_free_port).unwrap_or(DEFAULT_PORT)
}

/// 预选一个空闲端口（`127.0.0.1:0` 取回后释放）。
///
/// 释放与 sidecar bind 之间存在极小竞态窗口；命中时 Node 启动报
/// EADDRINUSE，就绪轮询超时可见，重启即可恢复（不为此加复杂度）。
pub fn pick_free_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
    listener.local_addr().ok().map(|addr| addr.port())
}

/// 从含 `DIVER_READY` 的日志行解析实际监听端口。
pub fn parse_ready_port(line: &str) -> Option<u16> {
    let idx = line.find("DIVER_READY")?;
    let rest = &line[idx + "DIVER_READY".len()..];
    let port_str = rest.rsplit(':').next()?.trim();
    port_str.split_whitespace().next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ready_port_reads_url() {
        assert_eq!(
            parse_ready_port("DIVER_READY http://127.0.0.1:53621"),
            Some(53621)
        );
        assert_eq!(
            parse_ready_port("[diver] DIVER_READY http://127.0.0.1:12345"),
            Some(12345)
        );
    }

    #[test]
    fn parse_ready_port_rejects_non_ready_lines() {
        assert_eq!(parse_ready_port("plain log line"), None);
        assert_eq!(parse_ready_port("DIVER_READY"), None);
        assert_eq!(parse_ready_port("DIVER_READY http://127.0.0.1:x"), None);
    }

    #[test]
    fn pick_free_port_returns_nonzero() {
        let port = pick_free_port().expect("bind 127.0.0.1:0 应成功");
        assert!(port != 0);
    }
}
