//! 本地 axum 服务启动与监听。

use std::sync::{Arc, Mutex};

use axum::Router;
use tauri::{AppHandle, Manager as TauriManager};

use super::rpc;
use super::state::{NotifyFn, PresenceDispatchFn, ServiceState};

/// 启动所有本地服务，返回监听端口。
///
/// `notify`：弹出原生通知的回调（由 app 层注入，services 不依赖 shell）。
/// `presence_dispatch`：presence RPC 分发（由 app 层注入，services 不依赖 core）。
pub fn start(
    app: &AppHandle,
    notify: NotifyFn,
    presence_dispatch: PresenceDispatchFn,
) -> Option<u16> {
    let dir = app.path().app_data_dir().ok()?;
    if let Err(err) = std::fs::create_dir_all(&dir) {
        log::warn!("services: 创建数据目录失败 {}: {err}", dir.display());
    }

    // ── memory 服务：SQLite 存储 ──────────────────────────────
    let memory_db = Arc::new(Mutex::new(
        diver_memory::db::MemoryDb::open(&dir.join("diver-memory.sqlite3")).ok()?,
    ));
    let state = ServiceState {
        memory_db,
        notify,
        presence_dispatch,
    };

    // 统一 RPC 入口；未来服务继续在 rpc::dispatch 中扩展。
    let app = Router::new().route("/rpc", axum::routing::post(rpc::dispatch)).with_state(state);

    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let port = std_listener.local_addr().ok()?.port();
    log::info!("本地服务监听 127.0.0.1:{port}");

    tauri::async_runtime::spawn(async move {
        if let Err(err) = std_listener.set_nonblocking(true) {
            log::error!("本地服务设置 nonblocking 失败: {err}");
            return;
        }
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(err) => {
                log::error!("本地服务转换为 tokio listener 失败: {err}");
                return;
            }
        };
        if let Err(err) = axum::serve(listener, app).await {
            log::error!("本地服务异常退出: {err}");
        }
    });

    Some(port)
}
