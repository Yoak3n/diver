//! 合成入口与声线解析（provider 分发）。

use tauri::AppHandle;

use crate::config::tts::{load_config, TtsAudio, TtsConfig, TtsProvider};

use super::{mimo, minimax, volcengine};

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
        TtsProvider::Mimo => mimo::synthesize_mimo(cfg, text, &voice).await,
        TtsProvider::Minimax => minimax::synthesize_minimax(cfg, text, &voice).await,
        TtsProvider::Volcengine => volcengine::synthesize_volcengine(cfg, text, &voice).await,
    }
}

/// 流式合成前的业务校验与声线解析（command 只转发）。
///
/// 非 MiMo 返回 `STREAM_UNSUPPORTED`（前端回退整段合成）。
pub fn resolve_stream_voice(cfg: &TtsConfig, voice_override: Option<&str>) -> Result<String, String> {
    if cfg.provider != TtsProvider::Mimo {
        return Err("STREAM_UNSUPPORTED".into());
    }
    let voice = voice_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cfg.voice.trim())
        .to_string();
    if voice.is_empty() {
        return Err("未选择声线".into());
    }
    Ok(voice)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(provider: TtsProvider, voice: &str) -> TtsConfig {
        TtsConfig {
            provider,
            voice: voice.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn resolve_stream_voice_mimo_success() {
        let c = cfg(TtsProvider::Mimo, "冰糖");
        let v = resolve_stream_voice(&c, None).unwrap();
        assert_eq!(v, "冰糖");
    }

    #[test]
    fn resolve_stream_voice_mimo_override() {
        let c = cfg(TtsProvider::Mimo, "冰糖");
        let v = resolve_stream_voice(&c, Some("茉莉")).unwrap();
        assert_eq!(v, "茉莉");
    }

    #[test]
    fn resolve_stream_voice_non_mimo_unsupported() {
        for p in [TtsProvider::Minimax, TtsProvider::Volcengine] {
            let c = cfg(p, "x");
            let e = resolve_stream_voice(&c, None).unwrap_err();
            assert_eq!(e, "STREAM_UNSUPPORTED");
        }
    }

    #[test]
    fn resolve_stream_voice_empty_voice_errors() {
        let c = cfg(TtsProvider::Mimo, "  ");
        let e = resolve_stream_voice(&c, None).unwrap_err();
        assert_eq!(e, "未选择声线");
    }

    #[test]
    fn resolve_stream_voice_override_empty_falls_back_then_errors() {
        let c = cfg(TtsProvider::Mimo, "");
        let e = resolve_stream_voice(&c, Some("   ")).unwrap_err();
        assert_eq!(e, "未选择声线");
    }
}
