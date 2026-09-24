//! Sidecar 生命周期管理：负责启动/监控/停止 Node harness 子进程。
//!
//! sidecar 是 Node 进程，运行自研 cos harness（统一 companion 组合：pluginPaths
//! 解析 @cos/* 核心、pluginRoot 解析开放插件目录、profile=companion 承载启停补丁）。
//! 通过 `DIVER_READY` 标志行报告就绪，随后由 WebView 通过
//! `http://127.0.0.1:{port}` 访问其自有的 HTTP/SSE 服务。
//! agent 常驻于 sidecar：窗口隐藏/销毁（轻量模式）不影响它持续运行。
//!
//! 两种形态（同一 loader 契约，已放弃 SEA 烘焙路径）：
//! - dev（debug 构建）：`node --import tsx .../cos-plugins/companion/src/companion.ts`，
//!   `--plugin-root <repo>/cos-plugins`、`--bundles .../bundle-companion`、
//!   `--harness <repo>/harness`、`--profile companion`。
//! - release：解析 Node（本机/缓存）+ `plugins/companion/src/companion-bundle.ts`（非 SEA）：
//!   `resources/sidecar/{harness/,plugins/,bundles/}`，
//!   cwd = resources/sidecar，COS_HOME = 用户数据目录（升级不丢数据）。
//!   Node 不随包：见 `node_runtime`（探测系统 Node，缺失则下载到应用缓存）。

mod command;
#[cfg(target_os = "windows")]
mod job_object;
mod launch;
mod lifecycle;
mod paths;
mod process;
mod reclaim;
mod shutdown;
mod status;

/// 非 Windows 平台的占位类型（SidecarManager 字段统一携带）。
#[cfg(not(target_os = "windows"))]
pub type SidecarJob = ();

/// Windows：把 Job Object 类型提升到模块可见（字段声明用）。
#[cfg(target_os = "windows")]
pub use job_object::SidecarJob;

pub use launch::{LaunchContext, LaunchHooks, PreflightStatus};
pub use paths::DEFAULT_PORT;
pub use process::SidecarManager;
pub use status::{SidecarState, SidecarStatus};
