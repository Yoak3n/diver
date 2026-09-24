//! Tauri 侧本地服务：仅监听 127.0.0.1，供 Node sidecar（dsh）调用。
//!
//! 使用 axum 承载 HTTP；服务通过 [ServiceState] 注册共享状态，
//! 在[start]中把各服务的路由 merge 进同一个 Router 即可扩展新服务。
//!
//! 依赖方向：services → config/crates；禁止 use `crate::app` / `crate::shell` / `crate::core`
//! （壳能力经 start 时注入的闭包提供）。

mod grep;
mod memory;
mod notify;
mod presence;
mod rpc;

use std::sync::{Arc, Mutex};

use axum::Router;
use serde_json::Value;
use tauri::{AppHandle, Manager as TauriManager};

/// 原生通知回调（app 层包一层 `shell::notify::show` 后注入）。
pub type NotifyFn = Arc<dyn Fn(String, String) + Send + Sync>;

/// presence RPC 分发回调（app 层包一层 `core::presence::dispatch_rpc` 后注入）。
pub type PresenceDispatchFn = Arc<dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync>;

/// 所有本地服务共享的状态；新增服务时在这里扩展字段。
#[derive(Clone)]
pub struct ServiceState {
    pub memory_db: Arc<Mutex<diver_memory::db::MemoryDb>>,
    pub notify: NotifyFn,
    pub presence_dispatch: PresenceDispatchFn,
}

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
