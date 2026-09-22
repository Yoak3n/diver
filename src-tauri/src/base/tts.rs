//! 在线 TTS：由壳层 Rust 直接请求服务商 API，返回音频字节。
//!
//! 参考 SillyTavern 的 TTS 扩展协议（MiMo / MiniMax / 火山），
//! 不在本地做 SAPI 朗读；播放由 WebView `<audio>` 完成。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tauri::AppHandle;

use crate::config::tts::{load_config, TtsAudio, TtsConfig, TtsProvider, TtsVoice};

// ---------- 内置声线 ----------

fn mimo_voices() -> Vec<TtsVoice> {
    [
        ("mimo_default", "mimo_default", "zh-CN"),
        ("冰糖", "冰糖 · 活泼少女", "zh-CN"),
        ("茉莉", "茉莉 · 知性女声", "zh-CN"),
        ("苏打", "苏打 · 阳光少年", "zh-CN"),
        ("白桦", "白桦 · 成熟男声", "zh-CN"),
        ("Mia", "Mia", "en-US"),
        ("Chloe", "Chloe", "en-US"),
        ("Milo", "Milo", "en-US"),
        ("Dean", "Dean", "en-US"),
    ]
    .into_iter()
    .map(|(id, name, lang)| TtsVoice {
        id: id.into(),
        name: name.into(),
        lang: lang.into(),
    })
    .collect()
}

fn minimax_voices() -> Vec<TtsVoice> {
    [
        ("female-tianmei", "甜美女声", "zh-CN"),
        ("female-shaonv", "少女音", "zh-CN"),
        ("female-yujie", "御姐音", "zh-CN"),
        ("female-chengshu", "成熟女声", "zh-CN"),
        ("male-qn-qingse", "青涩青年音", "zh-CN"),
        ("male-qn-jingying", "精英青年音", "zh-CN"),
        ("male-qn-badao", "霸道青年音", "zh-CN"),
        ("presenter_female", "女主持人", "zh-CN"),
        ("presenter_male", "男主持人", "zh-CN"),
        (
            "Chinese (Mandarin)_Unrestrained_Young_Man",
            "奔放青年男声",
            "zh-CN",
        ),
    ]
    .into_iter()
    .map(|(id, name, lang)| TtsVoice {
        id: id.into(),
        name: name.into(),
        lang: lang.into(),
    })
    .collect()
}

fn volcengine_voices() -> Vec<TtsVoice> {
    [
        ("zh_female_xiaohe_uranus_bigtts", "小何", "zh-CN"),
        ("zh_female_vv_uranus_bigtts", "薇薇", "zh-CN"),
        ("saturn_zh_female_keainvsheng_tob", "可爱女声", "zh-CN"),
        ("saturn_zh_female_tiaopigongzhu_tob", "调皮公主", "zh-CN"),
        ("saturn_zh_female_cancan_tob", "灿灿", "zh-CN"),
        ("saturn_zh_male_shuanglangshaonian_tob", "爽朗少年", "zh-CN"),
        ("saturn_zh_male_tiancaitongzhuo_tob", "天才同桌", "zh-CN"),
        ("zh_male_taocheng_uranus_bigtts", "陶诚", "zh-CN"),
    ]
    .into_iter()
    .map(|(id, name, lang)| TtsVoice {
        id: id.into(),
        name: name.into(),
        lang: lang.into(),
    })
    .collect()
}

/// 列出当前服务商的声线（内置预设 + 用户自定义 ID）。
pub fn list_voices(cfg: &TtsConfig) -> Vec<TtsVoice> {
    let mut voices = match cfg.provider {
        TtsProvider::Mimo => mimo_voices(),
        TtsProvider::Minimax => minimax_voices(),
        TtsProvider::Volcengine => volcengine_voices(),
    };
    for id in &cfg.custom_voices {
        if voices.iter().any(|v| &v.id == id) {
            continue;
        }
        voices.push(TtsVoice {
            id: id.clone(),
            name: id.clone(),
            lang: "zh-CN".into(),
        });
    }
    voices
}

/// 当前服务商可选模型（advisory）。
pub fn list_models(provider: TtsProvider) -> Vec<String> {
    match provider {
        TtsProvider::Mimo => vec![
            "mimo-v2.5-tts".into(),
            "mimo-v2.5-tts-voicedesign".into(),
            "mimo-v2.5-tts-voiceclone".into(),
        ],
        TtsProvider::Minimax => vec![
            "speech-02-hd".into(),
            "speech-02-turbo".into(),
            "speech-01".into(),
            "speech-01-240228".into(),
        ],
        TtsProvider::Volcengine => Vec::new(),
    }
}

// ---------- 合成 ----------

fn mime_of(format: &str) -> &'static str {
    match format {
        "wav" => "audio/wav",
        _ => "audio/mpeg",
    }
}

fn decode_hex_audio(hex: &str) -> Result<Vec<u8>, String> {
    let clean = hex.trim().trim_start_matches("0x").replace(' ', "");
    let padded = if clean.len() % 2 == 0 {
        clean
    } else {
        format!("0{clean}")
    };
    if !padded.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("MiniMax 返回的音频不是合法 hex".into());
    }
    let bytes: Result<Vec<u8>, _> = (0..padded.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&padded[i..i + 2], 16))
        .collect();
    bytes.map_err(|e| format!("hex 解码失败: {e}"))
}

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

/// 从壳层配置合成（命令入口）。
pub async fn synthesize_from_config(
    app: &AppHandle,
    text: &str,
    voice: Option<&str>,
) -> Result<TtsAudio, String> {
    let cfg = load_config(app);
    synthesize(&cfg, text, voice).await
}
