//! TTS 合成 RPC handler：`tts::synthesize` → 注入闭包（app 层包
//! `core::tts::synthesize_from_config`；services 不依赖 core / tauri）。
//!
//! 这是 QQ 语音出话（onebot 插件）的合成入口：调用方必须先做文本隐私遮蔽，
//! 再把遮蔽后的文本送来；本层只做参数校验与转发，不记录正文。
//!
//! 参数：`{ text: string, voice?: string }`；返回：`{ base64, mime }`。

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use super::ServiceState;

pub fn dispatch(
    state: &ServiceState,
    method: &str,
    params: &Value,
) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> {
    let synth = state.tts_synthesize.clone();
    let method = method.to_string();
    let text = params
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let voice = params
        .get("voice")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    Box::pin(async move {
        match method.as_str() {
            "tts::synthesize" => {
                if text.is_empty() {
                    return Err("text 必填".into());
                }
                synth(text, voice).await
            }
            _ => Err(format!("unknown tts method: {method}")),
        }
    })
}
