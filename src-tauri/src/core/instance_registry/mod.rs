//! 实例运行时注册表（P1-2）：`<app_data_dir>/instances/<id>.json`。
//!
//! 每个正在运行的 sidecar 一条：pid / port / 名字 / 启动时间。
//! 就绪时登记（`register`）、退出时注销（`deregister`）、启动时按 pid
//! 清扫崩溃残留（`sweep_stale_at`）。壳层 axum 的 `registry::list` RPC
//! （P2 消息路由的寻址基础）读同一份文件。
//!
//! 与 P0 实例清单（`app_config_dir/instances.json`，配置）分离：
//! 注册表是运行时簿记，随进程生死增删。

mod pid;
mod store;
mod types;

pub use pid::pid_alive;
pub use store::{deregister, deregister_at, list_at, register, register_at, sweep_stale_at};
pub use types::{InstanceRecord, RegistryTarget};
