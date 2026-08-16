//! Diver 记忆后端 crate。
//!
//! 本 crate 只负责 SQLite 存储与确定性记忆逻辑，不包含传输层；
//! HTTP RPC server 位于 `src-tauri/src/services`，便于后续在 Tauri 侧
//! 扩展更多本地服务。

pub mod db;
pub use rusqlite::Error;