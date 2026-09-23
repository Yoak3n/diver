//! sidecar 优雅退出（HTTP shutdown）与进程退出轮询。

use std::time::{Duration, Instant};

use super::process::SidecarManager;

/// 优雅退出等待上限：POST /api/shutdown 后轮询进程退出的最长时间。
pub(super) const GRACEFUL_EXIT_TIMEOUT: Duration = Duration::from_millis(2500);

/// stop() 优雅等待阶段进程退出轮询间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 向 sidecar 发起优雅退出请求。返回是否成功发出（不代表已退出）。
///
/// 纯 TCP HTTP POST：不依赖 curl（部分 Windows 无 curl.exe），也不起
/// 子进程（避免 GUI 下弹控制台黑窗），与 `init.rs` 健康探测同一思路。
pub(super) fn request_shutdown(mgr: &SidecarManager) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let port = mgr.port();
    let token = super::paths::shutdown_token();
    let body = format!(r#"{{"token":"{token}"}}"#);
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        log::warn!("sidecar shutdown 请求失败: 无法连接 127.0.0.1:{port}");
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let req = format!(
        "POST /api/shutdown HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    );
    if stream.write_all(req.as_bytes()).is_err() {
        log::warn!("sidecar shutdown 请求失败: 写入失败");
        return false;
    }
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf).unwrap_or(0);
    let text = String::from_utf8_lossy(&buf[..n]);
    let ok = text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200");
    if ok {
        log::info!("sidecar shutdown 请求返回 HTTP 200");
    } else {
        let status = text.lines().next().unwrap_or("").to_string();
        log::warn!("sidecar shutdown 请求返回: {status}");
    }
    ok
}

/// 轮询等待子进程退出，超时返回 false。
pub(super) fn wait_exit(child: &mut std::process::Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return false,
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}
