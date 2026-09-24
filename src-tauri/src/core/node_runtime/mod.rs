//! Node 运行时解析：优先本机 / 应用缓存，缺失时下载官方 zip 到用户数据目录。
//!
//! 安装包不随包 node.exe（体积从 ~70MB 降到 ~15–25MB）。启动 sidecar 前按
//! 下列顺序解析：
//! 1. `DIVER_NODE_BIN` 显式指定
//! 2. 旧版随包 `resources/sidecar/node.exe`（兼容已解压目录）
//! 3. 应用缓存 `%LOCALAPPDATA%/Diver/runtime/node-*/node.exe`
//! 4. PATH / 常见安装目录中的系统 Node（要求 ≥ MIN_NODE_MAJOR）
//! 5. 下载官方发行包到应用缓存（首次需网络；失败给出可操作错误）

mod download;
mod extract;
mod lookup;
mod process;
mod resolve;
mod types;

pub use resolve::resolve_node;
pub use types::{NodeRuntime, MIN_NODE_MAJOR};
