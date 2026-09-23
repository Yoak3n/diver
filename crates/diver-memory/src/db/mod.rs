//! SQLite 记忆存储：topics / events / relation-card / promises / self-history。
//!
//! 设计对应 Node 侧原 store.ts 的双层模型：
//! - events 为 append-only 真相源（陈述原文永不修改）
//! - topics 每主题一行，recall 只查这一层
//! - 衰减 / 激活 / 遗忘均为确定性逻辑，不调用任何 LLM
//!
//! 本文件只做模块声明与稳定 re-export；实现见子模块。

mod card;
mod entities;
mod events;
mod mappers;
mod promises;
mod schema;
mod self_history;
mod store;
mod topics;
mod types;
mod util;

#[cfg(test)]
mod tests;

pub use store::MemoryDb;
pub use types::*;
pub use util::SNAPSHOT_DEFAULT_LIMIT;
