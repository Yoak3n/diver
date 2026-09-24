//! Tauri 侧本地服务：仅监听 127.0.0.1，供 Node sidecar（dsh）调用。
//!
//! 使用 axum 承载 HTTP；服务通过 [ServiceState] 注册共享状态，
//! 在 [start] 中把各服务的路由 merge 进同一个 Router 即可扩展新服务。
//!
//! 依赖方向：services → config/crates；禁止 use `crate::app` / `crate::shell` / `crate::core`
//! （壳能力经 start 时注入的闭包提供）。

mod grep;
mod memory;
mod notify;
mod presence;
mod rpc;
mod server;
mod state;

pub use server::start;
pub use state::{NotifyFn, PresenceDispatchFn, ServiceState};
