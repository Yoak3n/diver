//! 在线 TTS：由壳层 Rust 直接请求服务商 API，返回音频字节。
//!
//! 参考 SillyTavern 的 TTS 扩展协议（MiMo / MiniMax / 火山），
//! 不在本地做 SAPI 朗读；播放由 WebView `<audio>` 完成。

mod audio_util;
mod synth;
mod voices;

pub use synth::{synthesize, synthesize_from_config, synthesize_mimo_stream};
pub use voices::{list_models, list_voices};
