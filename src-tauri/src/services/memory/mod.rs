//! memory 服务（`memory::*` RPC + 壳层卡片名编排入口）。
//!
//! 双库语义（P1-1）：`append_event` 的 `shared: true` 写共享库，events 读取
//! 私有∪共享合并（见 `diver_memory::db::DualDb`）；其余能力经解引用直达私有库。
//!
//! 分层：dispatch.rs 方法路由 | params.rs 参数/结果适配 | card_name.rs 卡片名编排。

mod card_name;
mod dispatch;
mod params;

pub use card_name::{clear_card_name_at, set_card_name_at};
pub use dispatch::dispatch;
