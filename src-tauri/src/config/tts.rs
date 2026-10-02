//! 在线 TTS 配置（壳层配置，`config_dir/tts.json`）。
//!
//! API Key 等凭据只落盘在本机配置，不回传给前端（`to_view` 只回布尔）。
//! 空串 secret 在 `merge_from` 时保留旧值，与设置面板「留空不改」一致。

use std::collections::BTreeMap;
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

/// 单个提供商的凭据槽（按提供商分槽保存，切换提供商不互相覆盖）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TtsProviderCredentials {
    pub api_host: String,
    pub api_key: String,
    pub resource_id: String,
}

/// 每实例音色覆盖（未给的项跟随全局；凭据不在此层，按提供商分槽解析）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TtsVoiceOverride {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub voice: Option<String>,
    pub speed: Option<f64>,
    pub style_instruction: Option<String>,
}

/// 各提供商缺省端点（分槽缺省值与 normalize 重置目标）。
fn default_api_host(provider: TtsProvider) -> &'static str {
    match provider {
        TtsProvider::Mimo => "https://api.xiaomimimo.com/v1",
        TtsProvider::Minimax => "https://api.minimax.io",
        TtsProvider::Volcengine => "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional",
    }
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
    /// 各提供商凭据分槽（key = 提供商 id）；legacy 三字段是激活提供商槽位的镜像。
    #[serde(default)]
    pub provider_credentials: BTreeMap<String, TtsProviderCredentials>,
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
            provider_credentials: BTreeMap::new(),
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
    /// 各提供商凭据视图（secret 只回布尔）。
    pub provider_credentials: Vec<TtsProviderCredentialsView>,
}

/// 凭据槽视图（secret 只回 `has_api_key` 布尔）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsProviderCredentialsView {
    pub provider: String,
    pub has_api_key: bool,
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
            provider_credentials: [TtsProvider::Mimo, TtsProvider::Minimax, TtsProvider::Volcengine]
                .into_iter()
                .map(|p| TtsProviderCredentialsView {
                    provider: p.as_str().into(),
                    has_api_key: !self.credentials_for(p).api_key.trim().is_empty(),
                })
                .collect(),
        }
    }

    /// 合并前端提交：secret 空串 = 留空不改；其余字段始终覆盖。
    pub fn merge_from(&mut self, patch: &TtsConfigPatch) {
        if let Some(v) = patch.enabled {
            self.enabled = v;
        }
        // 凭据槽先按本次 patch 生效提供商解析（此刻 self.provider 尚未切换，槽位归属不串）；
        // 空 secret = 留空不改（与设置面板一致）。
        let cred_provider = patch
            .provider
            .as_deref()
            .map(TtsProvider::parse)
            .unwrap_or(self.provider);
        let mut slot = self.credentials_for(cred_provider);
        let mut creds_touched = false;
        if let Some(v) = &patch.api_host {
            slot.api_host = v.trim().to_string();
            creds_touched = true;
        }
        if let Some(v) = &patch.api_key {
            let t = v.trim();
            if !t.is_empty() {
                slot.api_key = t.to_string();
            }
            creds_touched = true;
        }
        if let Some(v) = &patch.resource_id {
            slot.resource_id = v.trim().to_string();
            creds_touched = true;
        }
        if creds_touched {
            self.provider_credentials
                .insert(cred_provider.as_str().to_string(), slot);
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
        // legacy 三字段 = 激活提供商槽位的镜像（合成路径零改动）。
        if creds_touched || patch.provider.is_some() {
            let active = self.credentials_for(self.provider);
            self.api_host = active.api_host;
            self.api_key = active.api_key;
            self.resource_id = active.resource_id;
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
                    self.api_host = default_api_host(TtsProvider::Mimo).into();
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
                    self.api_host = default_api_host(TtsProvider::Minimax).into();
                }
            }
            TtsProvider::Volcengine => {
                // 火山模型独立成家（seed-tts-*）：旧家模型名不能带过去。
                if self.model.is_empty()
                    || self.model.starts_with("mimo-")
                    || self.model.starts_with("speech-")
                {
                    self.model = "seed-tts-2.0".into();
                }
                // Agent Plan 专属路径；存量非 /plan/ 旧端点一并迁过来。
                if self.api_host.is_empty()
                    || self.api_host.contains("xiaomimimo")
                    || self.api_host.contains("minimax")
                    || (self.api_host.contains("openspeech.bytedance.com")
                        && !self.api_host.contains("/plan/"))
                {
                    self.api_host = default_api_host(TtsProvider::Volcengine).into();
                }
            }
        }
    }

    /// 取某提供商的凭据槽：分槽优先；未存则给缺省端点与空凭据。
    pub fn credentials_for(&self, provider: TtsProvider) -> TtsProviderCredentials {
        self.provider_credentials
            .get(provider.as_str())
            .cloned()
            .unwrap_or_else(|| TtsProviderCredentials {
                api_host: default_api_host(provider).into(),
                api_key: String::new(),
                resource_id: String::new(),
            })
    }

    /// 合成有效配置：按项覆盖（未给的项跟随全局）；凭据随生效提供商换槽。
    pub fn resolve_override(&self, o: Option<&TtsVoiceOverride>) -> TtsConfig {
        let Some(o) = o else {
            return self.clone();
        };
        let mut c = self.clone();
        if let Some(p) = &o.provider {
            c.provider = TtsProvider::parse(p);
        }
        if let Some(m) = &o.model {
            c.model = m.trim().to_string();
        }
        if let Some(v) = &o.voice {
            c.voice = v.trim().to_string();
        }
        if let Some(s) = o.speed {
            c.speed = s.clamp(0.25, 4.0);
        }
        if let Some(s) = &o.style_instruction {
            c.style_instruction = s.trim().to_string();
        }
        let creds = self.credentials_for(c.provider);
        c.api_host = creds.api_host;
        c.api_key = creds.api_key;
        c.resource_id = creds.resource_id;
        c
    }

    /// 存量迁移：legacy 单槽凭据归位到激活提供商的分槽（幂等）。
    fn migrate_provider_credentials(&mut self) {
        if self.provider_credentials.is_empty()
            && (!self.api_key.is_empty() || !self.resource_id.is_empty())
        {
            self.provider_credentials.insert(
                self.provider.as_str().to_string(),
                TtsProviderCredentials {
                    api_host: self.api_host.clone(),
                    api_key: self.api_key.clone(),
                    resource_id: self.resource_id.clone(),
                },
            );
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
    cfg.migrate_provider_credentials();
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

    #[test]
    fn credentials_are_isolated_per_provider() {
        let mut cfg = TtsConfig::default();
        cfg.api_key = "mimo-key".into();
        // 存量迁移：legacy 槽归位到激活提供商
        cfg.migrate_provider_credentials();
        // 切到 minimax 并提交该提供商的凭据
        let patch = TtsConfigPatch {
            provider: Some("minimax".into()),
            api_key: Some("minimax-key".into()),
            ..Default::default()
        };
        cfg.merge_from(&patch);
        assert_eq!(cfg.provider, TtsProvider::Minimax);
        assert_eq!(cfg.api_key, "minimax-key"); // legacy 镜像 = 激活槽
        // mimo 的凭据仍在分槽里，不被覆盖
        assert_eq!(cfg.credentials_for(TtsProvider::Mimo).api_key, "mimo-key");
        assert_eq!(
            cfg.credentials_for(TtsProvider::Minimax).api_key,
            "minimax-key"
        );
    }

    #[test]
    fn resolve_override_swaps_credentials_with_provider() {
        let mut cfg = TtsConfig::default();
        cfg.api_key = "mimo-key".into();
        cfg.migrate_provider_credentials();
        cfg.provider_credentials.insert(
            "minimax".into(),
            TtsProviderCredentials {
                api_host: "https://api.minimax.io".into(),
                api_key: "minimax-key".into(),
                resource_id: String::new(),
            },
        );
        let o = TtsVoiceOverride {
            provider: Some("minimax".into()),
            voice: Some("茉莉".into()),
            ..Default::default()
        };
        let eff = cfg.resolve_override(Some(&o));
        assert_eq!(eff.provider, TtsProvider::Minimax);
        assert_eq!(eff.voice, "茉莉");
        assert_eq!(eff.api_key, "minimax-key");
        assert_eq!(eff.speed, cfg.speed); // 未给的项跟随全局
    }

    #[test]
    fn volcengine_normalize_keeps_model_family() {
        let mut cfg = TtsConfig::default();
        cfg.provider = TtsProvider::Volcengine;
        cfg.model = "mimo-v2.5-tts".into();
        // 存量非 /plan/ 旧端点一并迁到 Agent Plan 专属路径。
        cfg.api_host = "https://openspeech.bytedance.com/api/v3/tts/unidirectional".into();
        cfg.normalize_provider_defaults();
        assert_eq!(cfg.model, "seed-tts-2.0");
        assert_eq!(cfg.api_host, default_api_host(TtsProvider::Volcengine));
        assert!(cfg.api_host.contains("/plan/"));
    }

    #[test]
    fn load_migrates_legacy_credentials_into_slot() {
        let dir = std::env::temp_dir().join(format!("diver-tts-mig-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cfg = TtsConfig::default();
        cfg.api_key = "legacy-key".into();
        assert!(save_config_at(&dir, &cfg));
        let loaded = load_config_at(&dir);
        let slot = loaded
            .provider_credentials
            .get("mimo")
            .expect("迁移应已归位");
        assert_eq!(slot.api_key, "legacy-key");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
