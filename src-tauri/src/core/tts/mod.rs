//! 在线 TTS：由壳层 Rust 直接请求服务商 API，返回音频字节。
//!
//! 参考 SillyTavern 的 TTS 扩展协议（MiMo / MiniMax / 火山），
//! 不在本地做 SAPI 朗读；播放由 WebView 播放窗口完成。
//! 播放队列在 `player`（后端 latest-wins），事件推给 pet/main。

mod audio_util;
mod player;
mod player_types;
mod synth;
mod voices;

pub use player::TtsPlayer;
pub use player_types::{PlayerKind, TtsPlayerEvent};
pub use synth::{
    resolve_stream_voice, synthesize, synthesize_from_config, synthesize_mimo_stream,
};
pub use voices::{list_models, list_voices};
