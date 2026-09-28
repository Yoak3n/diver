//! sidecar 后台拉起与就绪轮询（不阻塞 setup / 窗口显示）。

use tauri::Emitter;

/// 无子进程 HTTP 健康探测（避免 curl/黑窗）。
fn http_health_ok(port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
    let req = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf).unwrap_or(0);
    let text = String::from_utf8_lossy(&buf[..n]);
    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")
}

/// 后台线程：解压依赖 + 解析/下载 Node + 启动 sidecar（不阻塞 setup / 窗口显示）。
pub(super) fn spawn_sidecar_background(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        let handle2 = handle.clone();
        let sidecar = crate::core::sidecar::SidecarManager::global();
        crate::core::setup_progress::emit_progress(
            &handle,
            "start",
            "正在启动助手…",
            0.0,
            false,
        );
        if sidecar.start(&handle2) {
            // 就绪以 DIVER_READY / HTTP health 为准；这里只表示进程已拉起
            crate::core::setup_progress::emit_progress(
                &handle,
                "start",
                "正在启动助手…",
                85.0,
                false,
            );
            // P1-2 多实例拉起：active 之外的 enabled 实例顺序拉起
            // （独立线程，不阻塞遮罩收起；顺序 = preflight 不竞态）。
            let handle3 = handle.clone();
            std::thread::spawn(move || {
                crate::core::sidecar::Runtimes::global().start_enabled_extras(&handle3);
            });
            // 轮询 health：backend 就绪后主动收起遮罩（不单靠 stdout 里的 DIVER_READY）
            let handle2 = handle.clone();
            std::thread::spawn(move || {
                let port = crate::core::sidecar::SidecarManager::global().port();
                for i in 0..40 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    if http_health_ok(port) {
                        crate::core::setup_progress::emit_progress(
                            &handle2,
                            "ready",
                            "就绪",
                            100.0,
                            true,
                        );
                        let _ = handle2.emit(
                            "backend://ready",
                            crate::core::sidecar::SidecarManager::global().status(),
                        );
                        return;
                    }
                    if i == 39 {
                        crate::core::setup_progress::emit_error(
                            &handle2,
                            "助手未就绪（HTTP 健康检查超时），请查看日志",
                        );
                    }
                }
            });
        } else {
            log::error!("sidecar 启动失败，请检查依赖安装状态");
            crate::core::setup_progress::emit_error(&handle, "助手启动失败，请查看日志");
        }
    });
}
