//! Diver grep 搜索后端 crate。
//!
//! 本 crate 只负责文件内容搜索逻辑（ripgrep 引擎库：grep-regex / grep-searcher /
//! ignore），**不包含传输层**。HTTP RPC handler 位于 `src-tauri/src/services`，
//! 与 `diver-memory` 的组织方式一致。
//! 约束：请勿在本 crate 内新增 HTTP / 网络 / 进程相关代码。

pub mod search;
