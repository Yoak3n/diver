//! 窗口管理器：全局单例 + 状态缓存 + 生命周期入口。
//!
//! 创建细节见 `create`；显示/切换/关闭见 `ops`。AppHandle 与托盘回调由
//! app/setup 注入，本模块不依赖 `crate::app`。

mod create;
mod manager;
mod ops;

pub use manager::Manager;
