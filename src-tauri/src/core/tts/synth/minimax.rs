//! MiniMax TTS（t2a_v2）。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use crate::config::tts::{TtsAudio, TtsConfig};

use super::super::audio_util::{decode_hex_audio, mime_of};

pub(super) async fn synthesize_minimax(
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
