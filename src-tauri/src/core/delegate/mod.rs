//! 任务委派监督（0.2.0 codingagent 任务委派，拍板：壳层 Rust）。
//!
//! 职责：解析适配器 → spawn CLI → 监督（见 supervise.rs：相变 + 45s 尾部摘要，
//! inject 收听不吵；终态 next-turn 唤醒回报）。回报经实例注册表端口注入发起
//! 实例的 session inbox（与 peer 消息同一根管，见 notify.rs）。tasks.json 按实例
//! `$COS_HOME` 落盘；壳重启后 running 记录清扫为 `unknown`（明示不可知，不自动重发）。
//!
//! 分层：types.rs 领域类型常量 | manager.rs 取消旗标注册表 | rpc.rs `delegate::*` 分发
//! | notify.rs 回报注入 | process.rs 进程 | resolve.rs 启动链解析 | supervise.rs 监督
//! | digest.rs 摘要。

pub mod digest;
pub mod process;
pub mod resolve;
pub mod supervise;

mod manager;
mod notify;
mod rpc;
mod types;

pub(crate) use manager::remove_running;
pub use notify::notify;
pub use rpc::dispatch_rpc;
pub use types::{DIGEST_INTERVAL, DEFAULT_TIMEOUT_SECS, Paths};
