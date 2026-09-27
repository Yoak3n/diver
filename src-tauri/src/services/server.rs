//! 本地 axum 服务启动与监听（P2-1 / BUG-002：全路由过 Host + Bearer 鉴权中间件）。

use axum::response::IntoResponse;
use axum::Router;
use tauri::{AppHandle, Manager as TauriManager};

use super::rpc;
use super::state::{CardNameFn, MemoryPool, NotifyFn, PresenceDispatchFn, RegistryListFn, ServiceState};

/// 鉴权中间件（P2-1）：Host 非回环 → 403，令牌不匹配 → 401（`services::auth`）。
/// 挂在 Router 最外层，未来新增路由自动继承。
async fn require_auth(
    axum::extract::State(token): axum::extract::State<String>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    match super::auth::authorize(req.headers(), &token) {
        Ok(()) => next.run(req).await,
        Err(super::auth::AuthError::Host) => {
            (axum::http::StatusCode::FORBIDDEN, "forbidden").into_response()
        }
        Err(super::auth::AuthError::Token) => {
            (axum::http::StatusCode::UNAUTHORIZED, "unauthorized").into_response()
        }
    }
}

/// 启动所有本地服务，返回监听端口。
///
/// `auth_token`：本地服务鉴权令牌（P2-1，app 层从 `core::sidecar::service_token`
/// 注入；services 不依赖 core）。
/// `notify`：弹出原生通知的回调（由 app 层注入，services 不依赖 shell）。
/// `presence_dispatch`：presence RPC 分发（由 app 层注入，services 不依赖 core）。
/// `memory_dbs` / `memory_fallback`：记忆双库按实例路由（P1-2 身份头路由）——
/// 每实例一份私有库 + 共享库（app 层按实例 id 派生后注入），无身份回退 active。
/// `on_card_name`：人格卡片名字变更回调（app 层包「写回实例清单 name」后注入）。
/// `registry_list`：实例注册表查询（P1-2 注册中心，app 层包 `instance_registry::list_at`）。
/// `groups_dir`：群组文件目录（P2-4 群实体，app 层 app_config_dir 注入）。
pub fn start(
    app: &AppHandle,
    auth_token: String,
    notify: NotifyFn,
    presence_dispatch: PresenceDispatchFn,
    memory_dbs: Vec<(String, crate::config::instances::MemoryPaths)>,
    memory_fallback: String,
    on_card_name: CardNameFn,
    registry_list: RegistryListFn,
    groups_dir: std::path::PathBuf,
) -> Option<u16> {
    let dir = app.path().app_data_dir().ok()?;
    if let Err(err) = std::fs::create_dir_all(&dir) {
        log::warn!("services: 创建数据目录失败 {}: {err}", dir.display());
    }

    // ── memory 服务：私有 + 共享双库（P1-1），按实例路由（P1-2 身份头） ──
    let mut memory = MemoryPool::new(memory_fallback.clone());
    for (id, paths) in memory_dbs {
        match diver_memory::db::DualDb::open(&paths.private, &paths.shared) {
            Ok(db) => {
                log::info!("记忆双库打开（{id}）：{}", paths.private.display());
                memory.insert(id, db);
            }
            Err(err) => log::error!("记忆双库打开失败（{id}）：{err:?}"),
        }
    }
    if !memory.contains(&memory_fallback) {
        log::error!("active 实例记忆库不可用，本地服务不启动");
        return None;
    }
    let state = ServiceState {
        memory,
        auth_token: auth_token.clone(),
        notify,
        presence_dispatch,
        on_card_name,
        registry_list,
        groups_dir,
    };
    // 群管理面板等用户 IPC（commands 层）消费同一份服务状态：
    // 改名/踢人/解散的群系统事件经同一注册表与投递面发出（State<ServiceState> 取用）。
    app.manage(state.clone());

    // 统一 RPC 入口 + 鉴权中间件（P2-1）；未来服务继续在 rpc::dispatch 中扩展。
    let app = Router::new()
        .route("/rpc", axum::routing::post(rpc::dispatch))
        .layer(axum::middleware::from_fn_with_state(auth_token, require_auth))
        .with_state(state);

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
