//! 各服务商合成请求与 MiMo 流式合成。
//!
//! 按 provider 拆分：`mimo` / `minimax` / `volcengine`；入口与声线解析在 `compose`。

mod compose;
mod mimo;
mod minimax;
mod volcengine;

pub use compose::{resolve_stream_voice, synthesize, synthesize_from_config};
pub use mimo::synthesize_mimo_stream;
