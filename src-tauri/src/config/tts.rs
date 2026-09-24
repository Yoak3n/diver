//! 在线 TTS 配置（壳层配置，`config_dir/tts.json`）。
//!
//! API Key 等凭据只落盘在本机配置，不回传给前端（`to_view` 只回布尔）。
//! 空串 secret 在 `merge_from` 时保留旧值，与设置面板「留空不改」一致。

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{config_dir, load_at, save_at};

pub const FILE_NAME: &str = "tts.json";

/// 在线 TTS 服务商。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TtsProvider {
    /// MiMo TTS（OpenAI 兼容 chat.completions + audio）。
    #[default]
    Mimo,
    /// MiniMax 语音合成（t2a_v2）。
    Minimax,
    /// 火山引擎 Agent 版（X-Api-Key；经典 App-Id/Access-Key 已废弃）。
    Volcengine,
}

impl TtsProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            TtsProvider::Mimo => "mimo",
            TtsProvider::Minimax => "minimax",
            TtsProvider::Volcengine => "volcengine",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            TtsProvider::Mimo => "MiMo TTS",
            TtsProvider::Minimax => "MiniMax",
            TtsProvider::Volcengine => "火山引擎 Agent",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "minimax" => TtsProvider::Minimax,
            // 旧 id 兼容：经典鉴权已废弃，统一落到 Agent 版
            "volcengine" | "volcengine_agent" => TtsProvider::Volcengine,
            _ => TtsProvider::Mimo,
        }
    }
}

/// 声线条目（内置预设 + 用户自定义）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsVoice {
    pub id: String,
    pub name: String,
    pub lang: String,
}

/// 完整配置（含 secret，只在壳层磁盘）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TtsConfig {
    pub enabled: bool,
    pub provider: TtsProvider,
    pub voice: String,
    pub model: String,
    pub speed: f64,
    /// 服务商 API 根地址 / 端点。
    pub api_host: String,
    /// 通用 API Key（MiMo / MiniMax / 火山 Agent）。
    pub api_key: String,
    /// 火山 Resource ID（Agent 计划可选）。
    pub resource_id: String,
    /// MiMo 风格指令（可选 user message）。
    pub style_instruction: String,
    /// 音频格式：mp3 / wav。
    pub format: String,
    /// 用户自定义声线 ID（MiniMax 克隆音色等）。
    pub custom_voices: Vec<String>,
}

impl Default for TtsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: TtsProvider::default(),
            voice: "冰糖".into(),
            model: "mimo-v2.5-tts".into(),
            speed: 1.0,
            api_host: "https://api.xiaomimimo.com/v1".into(),
            api_key: String::new(),
            resource_id: String::new(),
            style_instruction: String::new(),
            format: "mp3".into(),
            custom_voices: Vec::new(),
        }
    }
}

/// 回传给前端的视图（secret 只回 `has_*` 布尔）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsConfigView {
    pub enabled: bool,
    pub provider: String,
    pub provider_label: String,
    pub voice: String,
    pub model: String,
    pub speed: f64,
    pub api_host: String,
    pub has_api_key: bool,
    pub resource_id: String,
    pub style_instruction: String,
    pub format: String,
    pub custom_voices: Vec<String>,
}

impl TtsConfig {
    pub fn to_view(&self) -> TtsConfigView {
        TtsConfigView {
            enabled: self.enabled,
            provider: self.provider.as_str().into(),
            provider_label: self.provider.label().into(),
            voice: self.voice.clone(),
            model: self.model.clone(),
            speed: self.speed,
            api_host: self.api_host.clone(),
            has_api_key: !self.api_key.trim().is_empty(),
            resource_id: self.resource_id.clone(),
            style_instruction: self.style_instruction.clone(),
            format: self.format.clone(),
            custom_voices: self.custom_voices.clone(),
        }
    }

    /// 合并前端提交：secret 空串 = 留空不改；其余字段始终覆盖。
    pub fn merge_from(&mut self, patch: &TtsConfigPatch) {
        if let Some(v) = patch.enabled {
            self.enabled = v;
        }
        if let Some(v) = &patch.provider {
            self.provider = TtsProvider::parse(v);
        }
        if let Some(v) = &patch.voice {
            self.voice = v.clone();
        }
        if let Some(v) = &patch.model {
            self.model = v.clone();
        }
        if let Some(v) = patch.speed {
            self.speed = v.clamp(0.25, 4.0);
        }
        if let Some(v) = &patch.api_host {
            self.api_host = v.trim().to_string();
        }
        if let Some(v) = &patch.api_key {
            let t = v.trim();
            if !t.is_empty() {
                self.api_key = t.to_string();
            }
        }
        if let Some(v) = &patch.resource_id {
            self.resource_id = v.trim().to_string();
        }
        if let Some(v) = &patch.style_instruction {
            self.style_instruction = v.trim().to_string();
        }
        if let Some(v) = &patch.format {
            let f = v.trim().to_lowercase();
            if matches!(f.as_str(), "mp3" | "wav") {
                self.format = f;
            }
        }
        if let Some(v) = &patch.custom_voices {
            self.custom_voices = v
                .iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }
        // 按服务商校正缺省模型 / 端点（避免串配置）。
        self.normalize_provider_defaults();
    }

    /// 切换服务商后补齐该服务商的缺省模型与端点（仅当仍是别家缺省值时）。
    pub fn normalize_provider_defaults(&mut self) {
        match self.provider {
            TtsProvider::Mimo => {
                if self.model.is_empty() || self.model.starts_with("speech-") {
                    self.model = "mimo-v2.5-tts".into();
                }
                if self.api_host.is_empty() || self.api_host.contains("minimax") || self.api_host.contains("bytedance") {
                    self.api_host = "https://api.xiaomimimo.com/v1".into();
                }
            }
            TtsProvider::Minimax => {
                if self.model.is_empty() || self.model.starts_with("mimo-") {
                    self.model = "speech-02-hd".into();
                }
                if self.api_host.is_empty()
                    || self.api_host.contains("xiaomimimo")
                    || self.api_host.contains("bytedance")
                {
                    self.api_host = "https://api.minimax.io".into();
                }
            }
            TtsProvider::Volcengine => {
                if self.api_host.is_empty()
                    || self.api_host.contains("xiaomimimo")
                    || self.api_host.contains("minimax")
                {
                    self.api_host = "https://openspeech.bytedance.com/api/v3/tts/unidirectional".into();
                }
            }
        }
    }
}

/// 前端提交补丁（所有字段可选；secret 空串忽略）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TtsConfigPatch {
    pub enabled: Option<bool>,
    pub provider: Option<String>,
    pub voice: Option<String>,
    pub model: Option<String>,
    pub speed: Option<f64>,
    pub api_host: Option<String>,
    pub api_key: Option<String>,
    pub resource_id: Option<String>,
    pub style_instruction: Option<String>,
    pub format: Option<String>,
    pub custom_voices: Option<Vec<String>>,
}

/// 合成结果（base64 音频 + MIME）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsAudio {
    pub base64: String,
    pub mime: String,
}

/// 纯路径读取 TTS 配置。
pub fn load_config_at(base: &Path) -> TtsConfig {
    let mut cfg: TtsConfig = load_at(base, FILE_NAME);
    cfg.normalize_provider_defaults();
    cfg
}

/// 纯路径保存 TTS 配置。
pub fn save_config_at(base: &Path, config: &TtsConfig) -> bool {
    let mut cfg = config.clone();
    cfg.normalize_provider_defaults();
    save_at(base, FILE_NAME, &cfg)
}

pub fn load_config(app: &AppHandle) -> TtsConfig {
    load_config_at(&config_dir(app))
}

pub fn save_config(app: &AppHandle, config: &TtsConfig) -> bool {
    save_config_at(&config_dir(app), config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_save_at_roundtrip() {
        let dir = std::env::temp_dir().join(format!("diver-tts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cfg = TtsConfig::default();
        cfg.provider = TtsProvider::Minimax;
        cfg.voice = "茉莉".into();
        cfg.api_key = "secret".into();
        assert!(save_config_at(&dir, &cfg));
        let loaded = load_config_at(&dir);
        assert_eq!(loaded.provider, TtsProvider::Minimax);
        assert_eq!(loaded.voice, "茉莉");
        assert_eq!(loaded.api_key, "secret");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_at_missing_returns_default_with_normalized_provider() {
        let dir = std::env::temp_dir().join(format!("diver-tts-miss-{}", std::process::id()));
        let cfg = load_config_at(&dir);
        assert_eq!(cfg.provider, TtsProvider::Mimo);
        assert!(!cfg.model.is_empty());
    }
}
