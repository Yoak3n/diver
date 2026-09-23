//! 在线 TTS 相关 command。

use tauri::AppHandle;

use crate::base::tts;
use crate::config::tts::{
    load_config, save_config, TtsAudio, TtsConfigPatch, TtsConfigView, TtsProvider, TtsVoice,
};

/// 读取在线 TTS 配置（secret 只回 has_* 布尔）。
#[tauri::command]
pub fn get_tts_config(app: AppHandle) -> TtsConfigView {
    load_config(&app).to_view()
}

/// 保存在线 TTS 配置（secret 空串 = 留空不改）。
#[tauri::command]
pub fn set_tts_config(app: AppHandle, config: TtsConfigPatch) -> Result<TtsConfigView, String> {
    let mut cfg = load_config(&app);
    cfg.merge_from(&config);
    if !save_config(&app, &cfg) {
        return Err("写入 TTS 配置失败".into());
    }
    Ok(cfg.to_view())
}

/// 列出当前服务商的声线（内置预设 + 自定义）。
#[tauri::command]
pub fn tts_list_voices(app: AppHandle, provider: Option<String>) -> Vec<TtsVoice> {
    let mut cfg = load_config(&app);
    if let Some(p) = provider {
        cfg.provider = TtsProvider::parse(&p);
    }
    tts::list_voices(&cfg)
}

/// 列出当前服务商可选模型（advisory）。
#[tauri::command]
pub fn tts_list_models(provider: String) -> Vec<String> {
    tts::list_models(TtsProvider::parse(&provider))
}

/// 在线合成语音（返回 base64 音频）。`voice` 可覆盖配置中的声线。
#[tauri::command]
pub async fn tts_synthesize(
    app: AppHandle,
    text: String,
    voice: Option<String>,
) -> Result<TtsAudio, String> {
    tts::synthesize_from_config(&app, &text, voice.as_deref()).await
}

/// MiMo 流式合成：PCM 分片经 Channel 推送（24kHz PCM16LE）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsPcmChunk {
    /// base64(PCM16LE mono 24kHz)；done 时为空串。
    pub base64: String,
    pub done: bool,
}

/// 流式合成（当前仅 MiMo 真流式；其他服务商仍走 tts_synthesize）。
#[tauri::command]
pub async fn tts_synthesize_stream(
    app: AppHandle,
    text: String,
    voice: Option<String>,
    on_chunk: tauri::ipc::Channel<TtsPcmChunk>,
) -> Result<(), String> {
    let cfg = load_config(&app);
    if cfg.provider != TtsProvider::Mimo {
        // 非 MiMo：退化为整段合成后一次推完（前端仍按 PCM 无法播 mp3 → 由前端回退）
        return Err("STREAM_UNSUPPORTED".into());
    }
    let voice = voice
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cfg.voice.trim())
        .to_string();
    if voice.is_empty() {
        return Err("未选择声线".into());
    }
    tts::synthesize_mimo_stream(&cfg, &text, &voice, |base64, done| {
        on_chunk
            .send(TtsPcmChunk { base64, done })
            .map_err(|e| e.to_string())
    })
    .await
}
