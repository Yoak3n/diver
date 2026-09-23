//! MiMo TTS：整段合成 + 真流式 SSE。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use crate::config::tts::{TtsAudio, TtsConfig};

use super::super::audio_util::mime_of;

pub(super) async fn synthesize_mimo(
    cfg: &TtsConfig,
    text: &str,
    voice: &str,
) -> Result<TtsAudio, String> {
    let api_key = cfg.api_key.trim();
    if api_key.is_empty() {
        return Err("未配置 MiMo API Key".into());
    }
    let base = cfg.api_host.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置 MiMo API 地址".into());
    }
    let format = if cfg.format == "wav" { "wav" } else { "mp3" };

    // MiMo TTS：OpenAI 兼容 chat.completions，assistant = 目标文本，
    // 可选 user = 风格指令（与 SillyTavern mimo-tts 端点一致）。
    let mut messages: Vec<serde_json::Value> = Vec::new();
    let style = cfg.style_instruction.trim();
    if !style.is_empty() {
        messages.push(serde_json::json!({ "role": "user", "content": style }));
    }
    messages.push(serde_json::json!({ "role": "assistant", "content": text }));

    let body = serde_json::json!({
        "model": if cfg.model.trim().is_empty() { "mimo-v2.5-tts" } else { cfg.model.trim() },
        "messages": messages,
        "audio": { "format": format, "voice": voice },
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("MiMo TTS 请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("MiMo TTS HTTP {status}: {detail}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("MiMo TTS 响应解析失败: {e}"))?;
    let audio_b64 = json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("audio"))
        .and_then(|a| a.get("data"))
        .and_then(|d| d.as_str())
        .ok_or_else(|| "MiMo TTS 响应缺少 audio.data".to_string())?;

    let bytes = B64
        .decode(audio_b64)
        .map_err(|e| format!("MiMo 音频 base64 解码失败: {e}"))?;
    Ok(TtsAudio {
        base64: B64.encode(bytes),
        mime: mime_of(format).into(),
    })
}

/// MiMo 真流式：`stream: true` + `pcm16`，SSE 分片回调（24kHz PCM16LE mono）。
/// `on_chunk(base64_pcm, done)` 由调用方（Channel）注入。
pub async fn synthesize_mimo_stream<F>(
    cfg: &TtsConfig,
    text: &str,
    voice: &str,
    mut on_chunk: F,
) -> Result<(), String>
where
    F: FnMut(String, bool) -> Result<(), String>,
{
    use futures_util::StreamExt;

    let api_key = cfg.api_key.trim();
    if api_key.is_empty() {
        return Err("未配置 MiMo API Key".into());
    }
    let base = cfg.api_host.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置 MiMo API 地址".into());
    }
    let text = text.trim();
    if text.is_empty() {
        return Err("文本为空".into());
    }

    let mut messages: Vec<serde_json::Value> = Vec::new();
    let style = cfg.style_instruction.trim();
    if !style.is_empty() {
        messages.push(serde_json::json!({ "role": "user", "content": style }));
    }
    messages.push(serde_json::json!({ "role": "assistant", "content": text }));

    let body = serde_json::json!({
        "model": if cfg.model.trim().is_empty() { "mimo-v2.5-tts" } else { cfg.model.trim() },
        "messages": messages,
        // 流式协议要求 pcm16，前端按 24kHz PCM16LE 拼接播放
        "audio": { "format": "pcm16", "voice": voice },
        "stream": true,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("MiMo TTS 流式请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("MiMo TTS HTTP {status}: {detail}"));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| format!("MiMo 流读取失败: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        // SSE：按行解析 data: {...}
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim_end_matches('\r').to_string();
            buf = buf[nl + 1..].to_string();
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            let payload = payload.trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            let Ok(row) = serde_json::from_str::<serde_json::Value>(payload) else {
                continue;
            };
            let audio_b64 = row
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("delta"))
                .and_then(|d| d.get("audio"))
                .and_then(|a| a.get("data"))
                .and_then(|d| d.as_str());
            if let Some(b64) = audio_b64 {
                if !b64.is_empty() {
                    on_chunk(b64.to_string(), false)?;
                }
            }
        }
    }
    on_chunk(String::new(), true)?;
    Ok(())
}
