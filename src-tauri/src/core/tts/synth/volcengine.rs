//! 火山引擎 TTS（Agent Plan 版，`X-Api-Key` + `X-Api-Resource-Id`）。
//!
//! HTTP 接口 `…/api/v3/plan/tts/unidirectional`：Chunked NDJSON 流式返回，
//! 每行 `{code, data(base64), message}`，`code == 20000000` 为收尾。
//! 模型选择即 `X-Api-Resource-Id`（如 `seed-tts-2.0`）。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use crate::config::tts::{TtsAudio, TtsConfig};

const DEFAULT_ENDPOINT: &str = "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional";

/// NDJSON 行语义：音频分片 / 收尾 / 忽略。
enum Row {
    Audio(Vec<u8>),
    Done,
    Ignore,
}

fn endpoint_of(cfg: &TtsConfig) -> &str {
    let e = cfg.api_host.trim();
    if e.is_empty() {
        DEFAULT_ENDPOINT
    } else {
        e
    }
}

/// Agent Plan：模型选择 = `X-Api-Resource-Id`（如 `seed-tts-2.0`）；未填资源 id 时用 model 顶上。
fn resource_id_of(cfg: &TtsConfig) -> String {
    let rid = cfg.resource_id.trim();
    if !rid.is_empty() {
        return rid.to_string();
    }
    cfg.model.trim().to_string()
}

fn connect_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("diver-{nanos:x}")
}

/// 语速：Volcengine speech_rate 约 -50~100；由 0.5–2.0 倍率线性映射。
fn speech_rate_of(cfg: &TtsConfig) -> i64 {
    (((cfg.speed - 1.0) * 100.0).round() as i64).clamp(-50, 100)
}

fn build_body(cfg: &TtsConfig, text: &str, voice: &str, format: &str) -> serde_json::Value {
    serde_json::json!({
        "req_params": {
            "text": text,
            "speaker": voice,
            "audio_params": {
                "format": format,
                "sample_rate": 24000,
                "speech_rate": speech_rate_of(cfg),
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
    })
}

fn post_request(
    cfg: &TtsConfig,
    body: &serde_json::Value,
    timeout_secs: u64,
) -> Result<reqwest::RequestBuilder, String> {
    let api_key = cfg.api_key.trim();
    if api_key.is_empty() {
        return Err("未配置火山 Agent API Key".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())?;
    let req = client
        .post(endpoint_of(cfg))
        .json(body)
        .header("X-Api-Key", api_key)
        .header("X-Api-Connect-Id", connect_id());
    let rid = resource_id_of(cfg);
    Ok(if rid.is_empty() {
        req
    } else {
        req.header("X-Api-Resource-Id", rid)
    })
}

async fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let logid = resp
        .headers()
        .get("X-Tt-Logid")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let detail = resp.text().await.unwrap_or_default();
    Err(format!("火山 TTS HTTP {status} (logid={logid}): {detail}"))
}

/// 解析一行 NDJSON：`code==0` 取 `data` 音频，`code==20000000` 收尾，其余报错。
fn decode_row(line: &str) -> Result<Row, String> {
    let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
        return Ok(Row::Ignore);
    };
    let code = row.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code == 20000000 {
        return Ok(Row::Done);
    }
    if code != 0 {
        let msg = row
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("火山 TTS 流错误 code={code}: {msg}"));
    }
    match row.get("data").and_then(|d| d.as_str()) {
        Some(data) if !data.is_empty() => {
            let raw = B64
                .decode(data)
                .map_err(|e| format!("火山音频 base64 解码失败: {e}"))?;
            Ok(Row::Audio(raw))
        }
        _ => Ok(Row::Ignore),
    }
}

/// 首片若裹标准 RIFF/WAVE 头（44 字节）则剥掉，只送裸 PCM。
fn strip_wav_header(raw: &[u8]) -> &[u8] {
    if raw.len() > 44 && &raw[0..4] == b"RIFF" && &raw[8..12] == b"WAVE" {
        &raw[44..]
    } else {
        raw
    }
}

/// 整段合成（mp3，回退路径）。
pub(super) async fn synthesize_volcengine(
    cfg: &TtsConfig,
    text: &str,
    voice: &str,
) -> Result<TtsAudio, String> {
    let body = build_body(cfg, text, voice, "mp3");
    let resp = post_request(cfg, &body, 60)?
        .send()
        .await
        .map_err(|e| format!("火山 TTS 请求失败: {e}"))?;
    let resp = check_status(resp).await?;
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
        match decode_row(line)? {
            Row::Audio(raw) => audio.extend_from_slice(&raw),
            Row::Done => break,
            Row::Ignore => {}
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

/// 火山单向流式：HTTP Chunked NDJSON 边收边回调（PCM16LE 24kHz）。
/// `on_chunk(base64_pcm, done)` 契约与 MiMo 流一致。
pub async fn synthesize_volcengine_stream<F>(
    cfg: &TtsConfig,
    text: &str,
    voice: &str,
    mut on_chunk: F,
) -> Result<(), String>
where
    F: FnMut(String, bool) -> Result<(), String>,
{
    use futures_util::StreamExt;

    let text = text.trim();
    if text.is_empty() {
        return Err("文本为空".into());
    }
    // 流式协议走 PCM：前端按 24kHz PCM16LE 拼接播放。
    let body = build_body(cfg, text, voice, "pcm");
    let resp = post_request(cfg, &body, 120)?
        .send()
        .await
        .map_err(|e| format!("火山 TTS 流式请求失败: {e}"))?;
    let resp = check_status(resp).await?;

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut first = true;
    let mut got = false;
    loop {
        let line = if let Some(nl) = buf.find('\n') {
            let l = buf[..nl].trim_end_matches('\r').to_string();
            buf.drain(..=nl);
            l
        } else if let Some(item) = stream.next().await {
            let chunk = item.map_err(|e| format!("火山 TTS 流读取失败: {e}"))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            continue;
        } else if buf.trim().is_empty() {
            break;
        } else {
            std::mem::take(&mut buf)
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match decode_row(line)? {
            Row::Audio(raw) => {
                let raw = if first {
                    strip_wav_header(&raw)
                } else {
                    &raw[..]
                };
                first = false;
                if raw.is_empty() {
                    continue;
                }
                got = true;
                on_chunk(B64.encode(raw), false)?;
            }
            Row::Done => {
                on_chunk(String::new(), true)?;
                return Ok(());
            }
            Row::Ignore => {}
        }
    }
    if !got {
        return Err("火山 TTS 流未返回音频数据".into());
    }
    on_chunk(String::new(), true)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{decode_row, strip_wav_header, Row};

    #[test]
    fn decode_row_covers_all_kinds() {
        assert!(matches!(decode_row(r#"{"code":0,"data":"QUJD"}"#), Ok(Row::Audio(v)) if v.as_slice() == b"ABC"));
        assert!(matches!(decode_row(r#"{"code":20000000}"#), Ok(Row::Done)));
        assert!(decode_row(r#"{"code":1,"message":"boom"}"#).is_err());
        assert!(matches!(decode_row(r#"{"code":0}"#), Ok(Row::Ignore)));
        assert!(matches!(decode_row("not json"), Ok(Row::Ignore)));
    }

    #[test]
    fn strip_wav_header_only_strips_riff() {
        let mut wav = vec![0u8; 44 + 4];
        wav[0..4].copy_from_slice(b"RIFF");
        wav[8..12].copy_from_slice(b"WAVE");
        assert_eq!(strip_wav_header(&wav).len(), 4);
        assert_eq!(strip_wav_header(&[1, 2, 3]), &[1, 2, 3][..]);
    }
}
