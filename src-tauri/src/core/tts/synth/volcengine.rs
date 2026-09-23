//! 火山引擎 TTS（Agent 版 unidirectional NDJSON 流）。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use crate::config::tts::{TtsAudio, TtsConfig};

pub(super) async fn synthesize_volcengine(
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
