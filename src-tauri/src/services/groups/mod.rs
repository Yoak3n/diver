//! 群组消息与群务（P2-4）：`group::{list,say,create,invite,respond}`。
//! 群 = 壳层实体（`config::groups`，与实例注册表同层）；投递复用 peer 路由
//! （壳盖章 from/kind/group，对端 `/api/inbox` 注入）。
//!
//! 拍板：邀请裁决 = 被邀实例 agent 自主（respond 自决）；拒绝 = 显式告知邀请者 + 理由；
//! 群系统事件（入群等）走 `inject`（收听不吵）。
//!
//! 分层：rpc.rs 分发与参数 | body.rs 请求体与 fan-out id | list.rs 群清单
//! | say.rs 群发言与落账 | ops.rs 群务（建群/邀请/应答/目标解析）。

mod body;
mod list;
mod ops;
mod rpc;
mod say;

pub(crate) use body::{client_msg_id, group_body};
pub(crate) use ops::group_targets;
pub use rpc::dispatch;
pub(crate) use say::fan_out;
