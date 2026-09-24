//! Tauri IPC 薄适配层：按领域拆分 command，只做参数转换与调用 core。
//!
//! 业务分支与可单测纯逻辑放 core/ 或 crates/*（见 AGENTS.md）；本层不写业务。
//! 过渡期个别纯解析函数暂留本目录，Phase3 迁出。

mod config_cmds;
mod pet;
mod plugins;
mod presence;
mod shortcuts;
mod system;
mod tts;
mod tts_player;

pub use config_cmds::*;
pub use pet::*;
pub use plugins::*;
pub use presence::*;
pub use shortcuts::*;
pub use system::*;
pub use tts::*;
pub use tts_player::*;
