//! ExplorePolicy 壳驱动（设计 §7.4 / 切片 4）。
//!
//! 控制面：何时探索、探索哪个词 —— driver.rs（tick 裁决 + L1/L2 request）。
//! 执行面：sidecar `POST /api/memory/explore`（memory.explore → web-tools）—— rpc.rs。
//! job 生命周期：jobs.rs（启动后轮询等待 / 取消）。
//! 打断：USER_CHAT → 取消 job + EXPLORE_END（FSM T13 已迁 Listening）。

mod driver;
mod jobs;
mod log_fmt;
mod rpc;

pub use driver::{snapshot_json, spawn_explore_scheduler, trigger_manual};
pub use jobs::cancel_active_job;
