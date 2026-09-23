//! 各服务商合成请求与 MiMo 流式合成。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tauri::AppHandle;

use crate::config::tts::{load_config, TtsAudio, TtsConfig, TtsProvider};

use super::audio_util::{decode_hex_audio, mime_of};

/// 合成文本 → 音频（`voice` 为可选覆盖）。
pub async fn synthesize(
    cfg: &TtsConfig,
    text: &str,
    voice_override: Option<&str>,
) -> Result<TtsAudio, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("文本为空".into());
    }
    let voice = voice_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cfg.voice.trim())
        .to_string();
    if voice.is_empty() {
        return Err("未选择声线".into());
    }

    match cfg.provider {
        TtsProvider::Mimo => synthesize_mimo(cfg, text, &voice).await,
        TtsProvider::Minimax => synthesize_minimax(cfg, text, &voice).await,
        TtsProvider::Volcengine => synthesize_volcengine(cfg, text, &voice).await,
    }
}

async fn synthesize_mimo(
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

async fn synthesize_minimax(
    cfg: &TtsConfig,
    text: &str,
    voice: &str,
) -> Result<TtsAudio, String> {
    let api_key = cfg.api_key.trim();
    if api_key.is_empty() {
        return Err("未配置 MiniMax API Key".into());
    }
    let host = if cfg.api_host.trim().is_empty() {
        "https://api.minimax.io"
    } else {
        cfg.api_host.trim().trim_end_matches('/')
    };
    let format = if cfg.format == "wav" { "wav" } else { "mp3" };
    let model = if cfg.model.trim().is_empty() {
        "speech-02-hd"
    } else {
        cfg.model.trim()
    };

    let body = serde_json::json!({
        "model": model,
        "text": text,
        "stream": false,
        "voice_setting": {
            "voice_id": voice,
            "speed": cfg.speed,
            "vol": 1.0,
            "pitch": 0,
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": format,
            "channel": 1,
        },
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{host}/v1/t2a_v2"))
        .bearer_auth(api_key)
        .header("MM-API-Source", "Diver-TTS")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("MiniMax TTS 请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("MiniMax TTS HTTP {status}: {detail}"));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("MiniMax TTS 响应解析失败: {e}"))?;

    if let Some(base) = json.get("base_resp") {
        let code = base.get("status_code").and_then(|c| c.as_i64()).unwrap_or(0);
        if code != 0 {
            let msg = base
                .get("status_msg")
                .and_then(|m| m.as_str())
                .unwrap_or("未知错误");
            if code == 1004 {
                return Err("MiniMax 鉴权失败，请检查 API Key 与 API Host".into());
            }
            return Err(format!("MiniMax API 错误: {msg}"));
        }
    }

    // data.audio：hex 字符串；或 data.url：远程音频。
    if let Some(hex) = json
        .get("data")
        .and_then(|d| d.get("audio"))
        .and_then(|a| a.as_str())
    {
        let bytes = decode_hex_audio(hex)?;
        return Ok(TtsAudio {
            base64: B64.encode(bytes),
            mime: mime_of(format).into(),
        });
    }
    if let Some(url) = json
        .get("data")
        .and_then(|d| d.get("url"))
        .and_then(|u| u.as_str())
    {
        let audio = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("下载 MiniMax 音频失败: {e}"))?;
        if !audio.status().is_success() {
            return Err(format!("下载 MiniMax 音频 HTTP {}", audio.status()));
        }
        let bytes = audio
            .bytes()
            .await
            .map_err(|e| format!("读取 MiniMax 音频失败: {e}"))?;
        return Ok(TtsAudio {
            base64: B64.encode(&bytes),
            mime: mime_of(format).into(),
        });
    }

    Err("MiniMax 响应中没有音频数据".into())
}

async fn synthesize_volcengine(
    cfg: &TtsConfig,
    text: &str,
    voice: &str,
) -> Result<TtsAudio, String> {
    let endpoint = if cfg.api_host.trim().is_empty() {
        "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
    } else {
        cfg.api_host.trim()
    };

    // 语速：Volcengine speech_rate 约 -50~100；由 0.5–2.0 倍率线性映射。
    let speech_rate = (((cfg.speed - 1.0) * 100.0).round() as i64).clamp(-50, 100);

    let body = serde_json::json!({
        "req_params": {
            "text": text,
            "speaker": voice,
            "audio_params": {
                "format": "mp3",
                "speech_rate": speech_rate,
            },
            "additions": serde_json::json!({
                "mute_cut_threshold": "400",
                "mute_cut_remain_ms": "1",
                "explicit_language": "crosslingual",
                "enable_language_detector": true,
                "disable_markdown_filter": true,
            })
            .to_string(),
        }
    });

    // 火山 Agent 版：X-Api-Key（经典 App-Id/Access-Key 已废弃）
    let api_key = cfg.api_key.trim();
    if api_key.is_empty() {
        return Err("未配置火山 Agent API Key".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .post(endpoint)
        .json(&body)
        .header("X-Api-Key", api_key);
    let rid = cfg.resource_id.trim();
    if !rid.is_empty() {
        req = req.header("X-Api-Resource-Id", rid);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("火山 TTS 请求失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let logid = resp
            .headers()
            .get("X-Tt-Logid")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!(
            "火山 TTS HTTP {status} (logid={logid}): {detail}"
        ));
    }

    // NDJSON 流：每行 { code, data(base64), message }
    let body_text = resp
        .text()
        .await
        .map_err(|e| format!("读取火山 TTS 响应失败: {e}"))?;
    let mut audio: Vec<u8> = Vec::new();
    for line in body_text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let code = row.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
        if code != 0 && code != 20000000 {
            let msg = row
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("未知错误");
            return Err(format!("火山 TTS 流错误 code={code}: {msg}"));
        }
        if let Some(data) = row.get("data").and_then(|d| d.as_str()) {
            let chunk = B64
                .decode(data)
                .map_err(|e| format!("火山音频 base64 解码失败: {e}"))?;
            audio.extend_from_slice(&chunk);
        }
    }
    if audio.is_empty() {
        return Err("火山 TTS 未返回音频数据".into());
    }
    Ok(TtsAudio {
        base64: B64.encode(audio),
        mime: "audio/mpeg".into(),
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

/// 从壳层配置合成（命令入口）。
pub async fn synthesize_from_config(
    app: &AppHandle,
    text: &str,
    voice: Option<&str>,
) -> Result<TtsAudio, String> {
    let cfg = load_config(app);
    synthesize(&cfg, text, voice).await
}
